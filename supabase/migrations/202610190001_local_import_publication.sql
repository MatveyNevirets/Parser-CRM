-- Optional schema for publishing a user-confirmed local SQLite import into the shared CRM.
-- Apply manually after reviewing the SQL; this file is not executed by the application.
begin;

alter table public.leads
  add column city text,
  add column address text,
  add column import_source text,
  add column import_source_id text,
  add column source_url text;

create unique index leads_import_source_identity_active_idx
  on public.leads(workspace_id, import_source, import_source_id)
  where is_deleted = false and import_source is not null and import_source_id is not null;

create unique index leads_import_source_url_active_idx
  on public.leads(workspace_id, import_source, source_url)
  where is_deleted = false and import_source is not null and source_url is not null;

-- Contains only an idempotency key, a request digest, and the result report. No local drafts are staged here.
create table public.import_publication_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  report jsonb, 
  created_at timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);
alter table public.import_publication_requests enable row level security;
revoke all on public.import_publication_requests from public, anon, authenticated;

create function private.local_import_phone(p_phone text) returns text
language sql immutable set search_path = '' as $$
  select case when length(digits) = 11 and left(digits, 1) = '8' then '7' || substr(digits, 2) else digits end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as digits) normalized;
$$;
revoke all on function private.local_import_phone(text) from public, anon, authenticated;

create function private.local_import_candidate_exists(p_workspace_id uuid, p_source text, candidate jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.leads l
    where l.workspace_id = p_workspace_id and l.is_deleted = false and (
      (nullif(candidate->>'source_card_id', '') is not null
        and l.import_source = p_source and l.import_source_id = candidate->>'source_card_id')
      or (nullif(candidate->>'source_url', '') is not null and l.import_source = p_source and l.source_url = candidate->>'source_url')
      or (
        lower(trim(l.company_name)) = lower(trim(coalesce(candidate->>'company_name', '')))
        and lower(trim(l.niche)) = lower(trim(coalesce(candidate->>'niche', '')))
        and nullif(private.local_import_phone(candidate->>'phone'), '') is not null
        and private.local_import_phone(l.phone) = private.local_import_phone(candidate->>'phone')
      )
      or (
        lower(trim(l.company_name)) = lower(trim(coalesce(candidate->>'company_name', '')))
        and lower(trim(l.niche)) = lower(trim(coalesce(candidate->>'niche', '')))
        and nullif(trim(candidate->>'address'), '') is not null
        and lower(trim(coalesce(l.city, ''))) = lower(trim(coalesce(candidate->>'city', '')))
        and lower(trim(coalesce(l.address, ''))) = lower(trim(candidate->>'address'))
      )
    )
  );
$$;
revoke all on function private.local_import_candidate_exists(uuid, text, jsonb) from public, anon, authenticated;

create function public.preview_local_import_publication(
  p_workspace_id uuid,
  p_source text,
  p_candidates jsonb,
  p_excluded_count integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  selected integer;
  already_exists integer;
  to_create integer;
begin
  if auth.uid() is null or not private.is_member(p_workspace_id) then
    raise exception 'Нет доступа к рабочей команде.' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('2gis', 'yandex_maps') then
    raise exception 'Источник данных не поддерживается.' using errcode = '22023';
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 1000
    or p_excluded_count is null or p_excluded_count < 0 or p_excluded_count > 100000 then
    raise exception 'Некорректные параметры предварительной проверки.' using errcode = '22023';
  end if;
  selected := jsonb_array_length(p_candidates);
  select count(*) filter (where private.local_import_candidate_exists(p_workspace_id, p_source, candidate))::integer,
    count(*) filter (where not private.local_import_candidate_exists(p_workspace_id, p_source, candidate))::integer
  into already_exists, to_create
  from jsonb_array_elements(p_candidates) as expanded(candidate);
  return jsonb_build_object('to_create', coalesce(to_create, 0), 'already_exists', coalesce(already_exists, 0),
    'excluded', p_excluded_count, 'selected', selected);
end;
$$;

create function public.publish_local_import_candidates(
  p_workspace_id uuid,
  p_source text,
  p_idempotency_key uuid,
  p_confirmed boolean,
  p_candidates jsonb,
  p_excluded_count integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  v_request_hash text;
  previous_hash text;
  previous_report jsonb;
  candidate jsonb;
  candidate_id uuid;
  lead_id uuid;
  duplicate_ids integer;
  created_count integer := 0;
  existing_count integer := 0;
  failed_count integer := 0;
  item_results jsonb := '[]'::jsonb;
  publication_report jsonb;
  item_status text;
  error_reason text;
begin
  if actor is null or not private.is_member(p_workspace_id) then
    raise exception 'Нет доступа к рабочей команде.' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('2gis', 'yandex_maps') then
    raise exception 'Источник данных не поддерживается.' using errcode = '22023';
  end if;
  if p_confirmed is distinct from true then
    raise exception 'Для публикации требуется явное подтверждение пользователя.' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) = 0 or jsonb_array_length(p_candidates) > 1000
    or p_excluded_count is null or p_excluded_count < 0 or p_excluded_count > 100000 then
    raise exception 'Некорректные параметры публикации.' using errcode = '22023';
  end if;

  v_request_hash := md5(p_source || ':' || p_candidates::text || ':' || p_excluded_count::text);
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_idempotency_key::text, 0));
  insert into public.import_publication_requests(workspace_id, idempotency_key, request_hash)
    values (p_workspace_id, p_idempotency_key, v_request_hash) on conflict do nothing;
  select r.request_hash, r.report into previous_hash, previous_report
    from public.import_publication_requests as r
    where r.workspace_id = p_workspace_id and r.idempotency_key = p_idempotency_key for update;
  if previous_hash <> v_request_hash then
    raise exception 'Ключ публикации уже использован с другим содержимым.' using errcode = '22023';
  end if;
  if previous_report is not null then return previous_report; end if;

  select count(*) into duplicate_ids from (
    select value->>'candidate_id' from jsonb_array_elements(p_candidates) group by value->>'candidate_id' having count(*) > 1
  ) duplicate_rows;
  if duplicate_ids > 0 then raise exception 'В запросе повторяются ID карточек.' using errcode = '22023'; end if;

  for candidate in select value from jsonb_array_elements(p_candidates) loop
    candidate_id := null;
    lead_id := null;
    item_status := 'failed';
    error_reason := null;
    begin
      if coalesce(candidate->>'candidate_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'Некорректный ID промежуточной карточки.';
      end if;
      candidate_id := (candidate->>'candidate_id')::uuid;
      if length(trim(coalesce(candidate->>'company_name', ''))) not between 1 and 300
        or length(trim(coalesce(candidate->>'niche', ''))) not between 1 and 200
        or length(trim(coalesce(candidate->>'city', ''))) not between 1 and 200
        or length(coalesce(candidate->>'address', '')) > 500
        or length(coalesce(candidate->>'phone', '')) > 100
        or length(coalesce(candidate->>'website', '')) > 1000 then
        raise exception 'Поля карточки не прошли серверную проверку.';
      end if;
      if candidate->>'user_decision' is distinct from 'include' or candidate->>'import_status' is distinct from 'ready'
        or jsonb_typeof(candidate->'validation_errors') is distinct from 'array'
        or jsonb_array_length(candidate->'validation_errors') > 0
        or candidate->>'duplicate_kind' = 'exact'
        or candidate->>'branch_classification' is null
        or candidate->>'branch_classification' not in ('none', 'needs_review', 'confirmed', 'independent')
        or candidate->>'branch_override' is null
        or candidate->>'branch_override' not in ('unreviewed', 'independent', 'confirmed')
        or (candidate->>'branch_classification' in ('confirmed', 'needs_review') and candidate->>'branch_override' <> 'independent') then
        raise exception 'Карточка не отмечена как готовая для публикации.';
      end if;
      if nullif(candidate->>'source_card_id', '') is not null and length(candidate->>'source_card_id') > 200 then
        raise exception 'Идентификатор источника слишком длинный.';
      end if;
      if p_source = '2gis' and nullif(candidate->>'source_url', '') is not null
        and candidate->>'source_url' !~* '^https://(www[.])?2gis[.]ru/(?:[^/?#]+/)*firm/[0-9]+$' then
        raise exception 'Ссылка 2ГИС на карточку имеет недопустимый формат.';
      end if;
      if p_source = 'yandex_maps' and nullif(candidate->>'source_url', '') is not null
        and candidate->>'source_url' !~* '^https://(www[.])?yandex[.](ru|com)/maps/org/' then
        raise exception 'Ссылка на источник имеет недопустимый формат.';
      end if;
      if nullif(trim(candidate->>'phone'), '') is not null
        and length(private.local_import_phone(candidate->>'phone')) not between 7 and 15 then
        raise exception 'Телефон имеет недопустимый формат.';
      end if;
      if nullif(trim(candidate->>'website'), '') is not null
        and (candidate->>'website' !~* '^https?://[^[:space:]/]+([/?#][^[:space:]]*)?$'
          or split_part(split_part(candidate->>'website', '/', 3), ':', 1) not like '%.%') then
        raise exception 'Сайт имеет недопустимый формат.';
      end if;

      if private.local_import_candidate_exists(p_workspace_id, p_source, candidate) then
        item_status := 'already_exists';
        existing_count := existing_count + 1;
      else
        insert into public.leads(workspace_id, company_name, niche, phone, website, source_url,
          city, address, import_source, import_source_id)
        values (p_workspace_id, trim(candidate->>'company_name'), trim(candidate->>'niche'),
          nullif(trim(candidate->>'phone'), ''), nullif(trim(candidate->>'website'), ''), nullif(candidate->>'source_url', ''),
          trim(candidate->>'city'), nullif(trim(candidate->>'address'), ''), p_source, nullif(candidate->>'source_card_id', ''))
        returning id into lead_id;
        item_status := 'created';
        created_count := created_count + 1;
      end if;
    exception when unique_violation then
      if private.local_import_candidate_exists(p_workspace_id, p_source, candidate) then
        item_status := 'already_exists';
        existing_count := existing_count + 1;
      else
        error_reason := 'Конфликт уникальности при создании карточки.';
        failed_count := failed_count + 1;
      end if;
    when others then
      error_reason := 'Повторная серверная проверка карточки не пройдена.';
      failed_count := failed_count + 1;
    end;
    item_results := item_results || jsonb_build_array(jsonb_build_object(
      'candidate_id', candidate_id, 'lead_id', lead_id, 'status', item_status,
      'reason', error_reason
    ));
  end loop;

  publication_report := jsonb_build_object('created', created_count, 'already_exists', existing_count,
    'excluded', p_excluded_count, 'failed', failed_count,
    'status', case when failed_count > 0 then 'partially_completed' else 'completed' end,
    'items', item_results);
  update public.import_publication_requests set report = publication_report
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  return publication_report;
end;
$$;

revoke all on function public.preview_local_import_publication(uuid, text, jsonb, integer) from public, anon;
revoke all on function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer) from public, anon;
grant execute on function public.preview_local_import_publication(uuid, text, jsonb, integer) to authenticated;
grant execute on function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer) to authenticated;

grant insert (source_url) on public.leads to authenticated;
grant update (source_url) on public.leads to authenticated;

commit;

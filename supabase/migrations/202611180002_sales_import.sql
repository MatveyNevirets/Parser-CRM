begin;

-- Existing CRM projects may have skipped the optional parser migrations.
alter table public.leads
  add column if not exists city text,
  add column if not exists address text,
  add column if not exists import_source text,
  add column if not exists import_source_id text,
  add column if not exists source_url text;
grant insert (source_url), update (source_url) on public.leads to authenticated;

create unique index if not exists leads_import_source_identity_active_idx
  on public.leads(workspace_id, import_source, import_source_id)
  where is_deleted = false and import_source is not null and import_source_id is not null;
create unique index if not exists leads_import_source_url_active_idx
  on public.leads(workspace_id, import_source, source_url)
  where is_deleted = false and import_source is not null and source_url is not null;

create table if not exists public.import_publication_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  report jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);
alter table public.import_publication_requests enable row level security;
revoke all on public.import_publication_requests from public, anon, authenticated;

create or replace function private.local_import_text(value text) returns text
language sql immutable set search_path = '' as $$
  select trim(regexp_replace(lower(normalize(coalesce(value, ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'));
$$;

create or replace function private.local_import_name(value text) returns text
language sql immutable set search_path = '' as $$
  select trim(regexp_replace(regexp_replace(private.local_import_text(value),
    '^(ооо|ао|пао|оао|зао|ип|нко)( |$)', ''), '(^| )(ооо|ао|пао|оао|зао|ип|нко)$', ''));
$$;

-- Keep identities learned during import, including imports matched to older manual cards.
create table if not exists private.lead_import_identities (
  workspace_id uuid not null,
  source text not null,
  identity text not null,
  lead_id uuid not null,
  primary key (workspace_id, source, identity),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, id)
);
alter table private.lead_import_identities enable row level security;
revoke all on private.lead_import_identities from public, anon, authenticated;

create or replace function private.local_import_url_key(p_source text, p_url text) returns text
language sql immutable set search_path = '' as $$
  select coalesce('id:' || case p_source
    when '2gis' then substring(p_url from '(?i)^https?://(?:www[.])?2gis[.]ru/(?:[^/?#]+/)*firm/([0-9]+)(?:[/?#]|$)')
    when 'yandex_maps' then substring(p_url from '(?i)^https?://(?:www[.])?yandex[.](?:ru|com)/maps/org/(?:[^/?#]+/)?([0-9]+)(?:[/?#]|$)')
    end, 'url:' || nullif(rtrim(split_part(split_part(trim(p_url), '#', 1), '?', 1), '/'), ''));
$$;

create or replace function private.local_import_keys(p_source text, p_id text, p_url text, p_legacy_url text default null) returns text[]
language sql immutable set search_path = '' as $$
  select array_remove(array['id:' || nullif(p_id, ''), private.local_import_url_key(p_source, p_url),
    private.local_import_url_key(p_source, p_legacy_url)], null);
$$;

create or replace function private.local_import_phone(p_phone text) returns text
language sql immutable set search_path = '' as $$
  select case
    when length(digits) = 11 and left(digits, 1) = '8' then '7' || substr(digits, 2)
    when length(digits) = 10 and left(digits, 1) in ('3', '4', '8', '9') and left(ltrim(p_phone), 1) <> '+'
      then '7' || digits
    else digits end
  from (select regexp_replace(normalize(coalesce(p_phone, ''), NFKC), '[^0-9]', '', 'g') as digits) normalized;
$$;

create or replace function private.local_import_business_match(
  left_name text, left_city text, left_address text, left_phone text, left_has_source_id boolean,
  right_name text, right_city text, right_address text, right_phone text, right_has_source_id boolean
) returns boolean
language sql immutable set search_path = '' as $$
  select n1 <> '' and n1 = n2 and (
    (a1 <> '' and a1 = a2 and c1 <> '' and c1 = c2)
    or (not (left_has_source_id and right_has_source_id)
      and length(p1) between 7 and 15 and p1 = p2
      and (a1 = '' or a2 = '' or a1 = a2)
      and (c1 = '' or c2 = '' or c1 = c2))
  ) from (select private.local_import_name(left_name) n1, private.local_import_name(right_name) n2,
    private.local_import_text(left_city) c1, private.local_import_text(right_city) c2,
    private.local_import_text(left_address) a1, private.local_import_text(right_address) a2,
    private.local_import_phone(left_phone) p1, private.local_import_phone(right_phone) p2) normalized;
$$;

create index if not exists leads_import_business_name_idx on public.leads(workspace_id, private.local_import_name(company_name));
create index if not exists leads_import_source_keys_idx on public.leads using gin
  (private.local_import_keys(import_source, import_source_id, source_url));

create or replace function private.find_local_import_lead(p_team uuid, p_source text, c jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  keys text[] := private.local_import_keys(p_source, c->>'source_card_id', c->>'source_url');
  matched uuid;
begin
  -- Check source IDs before URLs and business attributes. Include archived and legacy deleted rows.
  select identity_match.id into matched from (
    select a.lead_id id, array_position(keys, a.identity) match_priority, 0 tie_priority
    from private.lead_import_identities a
    where a.workspace_id = p_team and a.source = p_source and a.identity = any(keys)
    union all
    select l.id, (select min(array_position(keys, k)) from unnest(
      private.local_import_keys(p_source, case when l.import_source = p_source then l.import_source_id end,
        l.source_url, case when p_source = 'yandex_maps' then l.yandex_maps_url end)) k where k = any(keys)), 1
    from public.leads l
    where l.workspace_id = p_team and (
      (l.import_source = p_source and private.local_import_keys(l.import_source, l.import_source_id, l.source_url) && keys)
      or (p_source = 'yandex_maps' and private.local_import_url_key(p_source, l.yandex_maps_url) = any(keys)))
    order by match_priority, tie_priority, id limit 1
  ) identity_match;
  if found then return matched; end if;
  select l.id into matched
    from public.leads l
    where l.workspace_id = p_team
      and private.local_import_name(l.company_name) = private.local_import_name(c->>'company_name')
      and private.local_import_business_match(l.company_name, l.city, l.address, l.phone,
        (l.import_source = p_source and
          (l.import_source_id is not null or coalesce(private.local_import_url_key(p_source, l.source_url) like 'id:%', false))) is true,
        c->>'company_name', c->>'city', c->>'address', c->>'phone',
        nullif(c->>'source_card_id', '') is not null
          or coalesce(private.local_import_url_key(p_source, c->>'source_url') like 'id:%', false))
    order by l.is_deleted, l.created_at, l.id limit 1;
  return matched;
end;
$$;

create or replace function private.local_import_candidate_exists(p_workspace_id uuid, p_source text, candidate jsonb) returns boolean
language sql volatile security definer set search_path = '' as $$
  select private.find_local_import_lead(p_workspace_id, p_source, candidate) is not null;
$$;

create or replace function private.validate_sales_import(p_workspace_id uuid, p_candidates jsonb, p_exclude_with_website boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_member(p_workspace_id) then
    raise exception 'Нет доступа к рабочей команде.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_candidates) is distinct from 'array' then
    raise exception 'Некорректный список карточек.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_candidates) > 1000 then
    raise exception 'Некорректный список карточек.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_candidates) c where
    nullif(c->>'duplicate_kind', '') is not null
    or (p_exclude_with_website is distinct from false and
      (c->>'website_check_status' = 'present' or nullif(trim(c->>'website'), '') is not null))) then
    raise exception 'В выбранных карточках найден сайт или дубль.' using errcode = '22023';
  end if;
  if exists (
    select private.local_import_name(c->>'company_name')
    from jsonb_array_elements(p_candidates) c
    group by private.local_import_name(c->>'company_name')
    having count(distinct coalesce(nullif(c->>'source_card_id', ''), nullif(c->>'source_url', ''), c->>'candidate_id')) > 2
  ) then
    raise exception 'Более двух карточек с одним названием: вся группа должна быть исключена.' using errcode = '22023';
  end if;
end;
$$;

create or replace function private.mark_parser_no_website() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.import_source in ('2gis', 'yandex_maps') and nullif(trim(new.website), '') is not null then
    new.website_status := 'hasWebsite';
  end if;
  return new;
end;
$$;

create or replace function private.publish_local_import_candidates_v1(
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
      if nullif(candidate->>'source_card_id', '') is not null
        and private.local_import_url_key(p_source, candidate->>'source_url') like 'id:%'
        and private.local_import_url_key(p_source, candidate->>'source_url') <> 'id:' || (candidate->>'source_card_id') then
        raise exception 'ID карточки отличается от ID в ссылке на источник.';
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

      lead_id := private.find_local_import_lead(p_workspace_id, p_source, candidate);
      if lead_id is not null then
        item_status := 'already_exists';
        existing_count := existing_count + 1;
      else
        insert into public.leads(workspace_id, company_name, niche, phone, website, source_url,
          city, address, import_source, import_source_id, website_status)
        values (p_workspace_id, trim(candidate->>'company_name'), trim(candidate->>'niche'),
          nullif(trim(candidate->>'phone'), ''), nullif(trim(candidate->>'website'), ''), nullif(candidate->>'source_url', ''),
          trim(candidate->>'city'), nullif(trim(candidate->>'address'), ''), p_source, nullif(candidate->>'source_card_id', ''),
          case
            when candidate->>'website_check_status' = 'present' or nullif(trim(candidate->>'website'), '') is not null then 'hasWebsite'
            when candidate->>'website_check_status' = 'absent' or not (candidate ? 'website_filter_disabled') then 'noWebsite'
            else 'unknown'
          end)
        returning id into lead_id;
        item_status := 'created';
        created_count := created_count + 1;
      end if;
      insert into private.lead_import_identities(workspace_id, source, identity, lead_id)
      select p_workspace_id, p_source, identity, lead_id
      from unnest(private.local_import_keys(p_source, candidate->>'source_card_id', candidate->>'source_url')) identity
      on conflict on constraint lead_import_identities_pkey do nothing;
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
      'candidate_id', candidate_id, 'lead_id', case when item_status = 'created' then lead_id else null end, 'status', item_status,
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


drop function if exists public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer);
create or replace function public.publish_local_import_candidates(
  p_workspace_id uuid, p_source text, p_idempotency_key uuid, p_confirmed boolean,
  p_candidates jsonb, p_excluded_count integer, p_exclude_with_website boolean default true
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.validate_sales_import(p_workspace_id, p_candidates, p_exclude_with_website);
  -- The existing request digest also binds the disabled website filter.
  if p_exclude_with_website is false then
    select coalesce(jsonb_agg(c || jsonb_build_object('website_filter_disabled', true) order by position), '[]'::jsonb)
    into p_candidates from jsonb_array_elements(p_candidates) with ordinality e(c, position);
  elsif exists (select 1 from jsonb_array_elements(p_candidates) c where c ? 'website_filter_disabled') then
    raise exception 'Некорректный режим фильтрации сайтов.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('local-import:' || p_workspace_id::text, 0));
  return private.publish_local_import_candidates_v1(p_workspace_id, p_source, p_idempotency_key,
    p_confirmed, p_candidates, p_excluded_count);
end;
$$;

drop function if exists public.preview_local_import_publication(uuid, text, jsonb, integer);
create or replace function public.preview_local_import_publication(
  p_workspace_id uuid, p_source text, p_candidates jsonb, p_excluded_count integer,
  p_exclude_with_website boolean default true
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb;
  keys text[];
  seen_keys text[] := '{}'::text[];
  new_cards jsonb := '[]'::jsonb;
  existing integer := 0;
begin
  perform private.validate_sales_import(p_workspace_id, p_candidates, p_exclude_with_website);
  if p_source is null or p_source not in ('2gis', 'yandex_maps')
    or p_excluded_count is null or p_excluded_count not between 0 and 100000 then
    raise exception 'Некорректные параметры предварительной проверки.' using errcode = '22023';
  end if;
  for c in select value from jsonb_array_elements(p_candidates) loop
    keys := private.local_import_keys(p_source, c->>'source_card_id', c->>'source_url');
    if keys && seen_keys or private.local_import_candidate_exists(p_workspace_id, p_source, c) or exists (
      select 1 from jsonb_array_elements(new_cards) prior
      where private.local_import_name(prior->>'company_name') = private.local_import_name(c->>'company_name')
        and private.local_import_business_match(prior->>'company_name', prior->>'city', prior->>'address', prior->>'phone',
          exists (select 1 from unnest(private.local_import_keys(p_source, prior->>'source_card_id', prior->>'source_url')) k where k like 'id:%'),
          c->>'company_name', c->>'city', c->>'address', c->>'phone',
          exists (select 1 from unnest(keys) k where k like 'id:%'))
    ) then
      existing := existing + 1;
    else
      new_cards := new_cards || jsonb_build_array(c);
    end if;
    seen_keys := seen_keys || keys;
  end loop;
  return jsonb_build_object('to_create', jsonb_array_length(new_cards), 'already_exists', existing,
    'excluded', p_excluded_count, 'selected', jsonb_array_length(p_candidates));
end;
$$;

revoke all on function private.local_import_text(text), private.local_import_name(text), private.local_import_phone(text),
  private.local_import_url_key(text, text), private.local_import_keys(text, text, text, text),
  private.local_import_business_match(text, text, text, text, boolean, text, text, text, text, boolean),
  private.find_local_import_lead(uuid, text, jsonb), private.validate_sales_import(uuid, jsonb, boolean),
  private.local_import_candidate_exists(uuid, text, jsonb), private.mark_parser_no_website(),
  private.publish_local_import_candidates_v1(uuid, text, uuid, boolean, jsonb, integer) from public, anon, authenticated;
-- Regular lead edits evaluate the index expressions with the authenticated role.
grant execute on function private.local_import_name(text), private.local_import_text(text),
  private.local_import_url_key(text, text), private.local_import_keys(text, text, text, text) to authenticated;
revoke all on function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer, boolean),
  public.preview_local_import_publication(uuid, text, jsonb, integer, boolean) from public, anon;
grant execute on function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer, boolean),
  public.preview_local_import_publication(uuid, text, jsonb, integer, boolean) to authenticated;

commit;

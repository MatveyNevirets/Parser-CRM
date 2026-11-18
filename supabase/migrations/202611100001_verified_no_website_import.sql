-- Only verified no-website cards may be published by the parser.
begin;

create function private.local_import_text(value text) returns text
language sql immutable set search_path = '' as $$
  select trim(regexp_replace(lower(normalize(coalesce(value, ''), NFKC)), '[^[:alnum:]]+', ' ', 'g'));
$$;
create function private.local_import_name(value text) returns text
language sql immutable set search_path = '' as $$
  select trim(regexp_replace(regexp_replace(private.local_import_text(value),
    '^(ооо|ао|пао|оао|зао|ип|нко)( |$)', ''), '(^| )(ооо|ао|пао|оао|зао|ип|нко)$', ''));
$$;

create or replace function private.local_import_candidate_exists(p_workspace_id uuid, p_source text, candidate jsonb) returns boolean
language sql volatile security definer set search_path = '' as $$
  select exists (
    select 1 from public.leads l
    where l.workspace_id = p_workspace_id and l.is_deleted = false and (
      (nullif(candidate->>'source_card_id', '') is not null
        and l.import_source = p_source and l.import_source_id = candidate->>'source_card_id')
      or (nullif(candidate->>'source_url', '') is not null
        and (l.source_url = candidate->>'source_url' or l.yandex_maps_url = candidate->>'source_url'))
      or (private.local_import_name(l.company_name) = private.local_import_name(candidate->>'company_name') and (
        (nullif(private.local_import_phone(candidate->>'phone'), '') is not null
          and private.local_import_phone(l.phone) = private.local_import_phone(candidate->>'phone'))
        or (private.local_import_text(l.city) = private.local_import_text(candidate->>'city')
          and (nullif(trim(l.address), '') is null or nullif(trim(candidate->>'address'), '') is null
            or private.local_import_text(l.address) = private.local_import_text(candidate->>'address')))
      ))
    )
  );
$$;

create function private.validate_no_website_import(p_workspace_id uuid, p_candidates jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_member(p_workspace_id) then
    raise exception 'Нет доступа к рабочей команде.' using errcode = '42501';
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 1000 then
    raise exception 'Некорректный список карточек.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_candidates) c where
    c->>'website_check_status' is distinct from 'absent'
    or nullif(trim(c->>'website'), '') is not null
    or nullif(c->>'duplicate_kind', '') is not null) then
    raise exception 'Импорт принимает только проверенные карточки без сайта и дублей. Повторите сбор старого пакета.' using errcode = '22023';
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

-- Keep the existing field validation and idempotent reports behind guarded entry points.
alter function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer) set schema private;
alter function private.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer) rename to publish_local_import_candidates_v1;
revoke all on function private.publish_local_import_candidates_v1(uuid, text, uuid, boolean, jsonb, integer) from public, anon, authenticated;

create function public.publish_local_import_candidates(
  p_workspace_id uuid, p_source text, p_idempotency_key uuid, p_confirmed boolean,
  p_candidates jsonb, p_excluded_count integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.validate_no_website_import(p_workspace_id, p_candidates);
  -- Different requests for the same workspace must not race past the existence check.
  perform pg_advisory_xact_lock(hashtextextended('local-import:' || p_workspace_id::text, 0));
  return private.publish_local_import_candidates_v1(p_workspace_id, p_source, p_idempotency_key,
    p_confirmed, p_candidates, p_excluded_count);
end;
$$;

alter function public.preview_local_import_publication(uuid, text, jsonb, integer) set schema private;
alter function private.preview_local_import_publication(uuid, text, jsonb, integer) rename to preview_local_import_publication_v1;
revoke all on function private.preview_local_import_publication_v1(uuid, text, jsonb, integer) from public, anon, authenticated;

create function public.preview_local_import_publication(
  p_workspace_id uuid, p_source text, p_candidates jsonb, p_excluded_count integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  candidate jsonb;
  previous jsonb := '[]'::jsonb;
  duplicates integer := 0;
  base_report jsonb;
begin
  perform private.validate_no_website_import(p_workspace_id, p_candidates);
  base_report := private.preview_local_import_publication_v1(p_workspace_id, p_source, p_candidates, p_excluded_count);
  -- Also count duplicates within this request, before any leads have been inserted.
  for candidate in select value from jsonb_array_elements(p_candidates) loop
    if not private.local_import_candidate_exists(p_workspace_id, p_source, candidate) and exists (
      select 1 from jsonb_array_elements(previous) c where
        (nullif(candidate->>'source_card_id', '') is not null and c->>'source_card_id' = candidate->>'source_card_id')
        or (nullif(candidate->>'source_url', '') is not null and c->>'source_url' = candidate->>'source_url')
        or (private.local_import_name(c->>'company_name') = private.local_import_name(candidate->>'company_name') and (
          (nullif(private.local_import_phone(candidate->>'phone'), '') is not null
            and private.local_import_phone(c->>'phone') = private.local_import_phone(candidate->>'phone'))
          or (private.local_import_text(c->>'city') = private.local_import_text(candidate->>'city')
            and (nullif(trim(c->>'address'), '') is null or nullif(trim(candidate->>'address'), '') is null
              or private.local_import_text(c->>'address') = private.local_import_text(candidate->>'address')))
        ))
    ) then duplicates := duplicates + 1; end if;
    previous := previous || jsonb_build_array(candidate);
  end loop;
  return base_report || jsonb_build_object(
    'to_create', (base_report->>'to_create')::integer - duplicates,
    'already_exists', (base_report->>'already_exists')::integer + duplicates);
end;
$$;

create function private.mark_parser_no_website() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.import_source in ('2gis', 'yandex_maps') and nullif(trim(new.website), '') is null then
    new.website_status := 'noWebsite';
  end if;
  return new;
end;
$$;
create trigger mark_parser_no_website before insert on public.leads
  for each row execute function private.mark_parser_no_website();

revoke all on function private.local_import_text(text), private.local_import_name(text),
  private.validate_no_website_import(uuid, jsonb), private.mark_parser_no_website() from public, anon, authenticated;
revoke all on function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer),
  public.preview_local_import_publication(uuid, text, jsonb, integer) from public, anon;
grant execute on function public.publish_local_import_candidates(uuid, text, uuid, boolean, jsonb, integer),
  public.preview_local_import_publication(uuid, text, jsonb, integer) to authenticated;
commit;

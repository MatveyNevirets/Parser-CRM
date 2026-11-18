-- Invalidate legacy no-website claims and bind fresh checks to a canonical 2GIS card.
begin;

create function private.local_import_has_current_no_website_check(candidate jsonb) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  checked_at timestamptz;
  source_url text := candidate->>'source_url';
begin
  if candidate->>'source' is distinct from '2gis'
    or candidate->>'website_check_status' is distinct from 'absent'
    or candidate->'website_check_version' is distinct from '2'::jsonb
    or candidate->>'website_checked_at' is null
    or candidate->>'website_checked_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or nullif(trim(candidate->>'website'), '') is not null
    or nullif(candidate->>'source_card_id', '') is null
    or source_url is null
    or candidate->>'website_checked_source_url' is distinct from source_url
    or source_url !~ '^https://2gis[.]ru/(?:[^/?#]+/)*firm/[0-9]+$'
    or source_url ~ '[[:space:]]'
    or source_url ~ '[^ -~]'
    or source_url ~* '/(?:[.]|%2e){1,2}/'
    or substring(source_url from '/firm/([0-9]+)$') is distinct from candidate->>'source_card_id' then
    return false;
  end if;
  begin
    checked_at := (candidate->>'website_checked_at')::timestamptz;
  exception when others then
    return false;
  end;
  return checked_at is not null and isfinite(checked_at)
    and checked_at >= now() - interval '24 hours'
    and checked_at <= now() + interval '60 seconds';
end;
$$;

create or replace function private.validate_no_website_import(p_workspace_id uuid, p_candidates jsonb) returns void
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
    not private.local_import_has_current_no_website_check(c)
    or nullif(c->>'duplicate_kind', '') is not null) then
    raise exception 'Требуется повторная проверка контактов 2ГИС: импорт принимает только проверенные карточки без сайта с актуальным подтверждением и без дублей.' using errcode = '22023';
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

revoke all on function private.local_import_has_current_no_website_check(jsonb),
  private.validate_no_website_import(uuid, jsonb) from public, anon, authenticated;
commit;

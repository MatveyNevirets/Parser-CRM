-- An incomplete website check remains reviewable. A discovered site blocks publication.
begin;

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
    c->>'website_check_status' = 'present'
    or nullif(trim(c->>'website'), '') is not null
    or nullif(c->>'duplicate_kind', '') is not null) then
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

revoke all on function private.validate_no_website_import(uuid, jsonb) from public, anon, authenticated;
commit;

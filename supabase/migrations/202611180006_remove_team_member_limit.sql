begin;

create or replace function public.join_workspace(invite text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  team uuid;
  existing_team uuid;
begin
  if actor is null then raise exception 'Сначала войдите в аккаунт.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select id into team from public.workspaces where invite_code = lower(trim(invite)) for key share;
  if team is null then raise exception 'Код команды не найден.'; end if;
  select workspace_id into existing_team from public.workspace_members where user_id = actor;
  if existing_team = team then return team; end if;
  if existing_team is not null then raise exception 'Вы уже состоите в другой команде.'; end if;

  insert into public.workspace_members(workspace_id, user_id) values (team, actor);
  return team;
end;
$$;

revoke all on function public.join_workspace(text) from public, anon;
grant execute on function public.join_workspace(text) to authenticated;

commit;

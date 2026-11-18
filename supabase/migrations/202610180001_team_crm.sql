-- Run once in the Supabase SQL Editor as the project owner.
begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 100),
  owner_id uuid not null references auth.users(id),
  invite_code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  company_name text not null check (length(trim(company_name)) between 1 and 300),
  niche text not null check (length(trim(niche)) between 1 and 200),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  status text not null default 'newLead' check (status in ('newLead', 'inProgress', 'waiting', 'contacted', 'qualified', 'rejected')),
  website_status text not null default 'unknown' check (website_status in ('unknown', 'hasWebsite', 'poorWebsite', 'noWebsite')),
  phone text,
  website text,
  yandex_maps_url text,
  notes text check (length(notes) <= 50000),
  next_action_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid not null default auth.uid() references auth.users(id),
  version integer not null default 1,
  -- Soft delete emits an UPDATE with workspace_id, so Realtime can filter it.
  is_deleted boolean not null default false
);
create index leads_workspace_active_idx on public.leads(workspace_id, is_deleted, id);

create function private.is_member(team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_members
    where workspace_id = team_id and user_id = (select auth.uid()));
$$;
revoke all on function private.is_member(uuid) from public;
grant execute on function private.is_member(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.leads enable row level security;

create policy workspace_read on public.workspaces for select to authenticated
  using (private.is_member(id));
create policy membership_read on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy leads_read on public.leads for select to authenticated
  using (private.is_member(workspace_id));
create policy leads_insert on public.leads for insert to authenticated
  with check (private.is_member(workspace_id) and created_by = (select auth.uid()));
create policy leads_update on public.leads for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));

revoke all on public.workspaces, public.workspace_members, public.leads from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.leads to authenticated;
grant insert (id, workspace_id, company_name, niche, priority, status, website_status,
  phone, website, yandex_maps_url, notes, next_action_at) on public.leads to authenticated;
grant update (company_name, niche, priority, status, website_status,
  phone, website, yandex_maps_url, notes, next_action_at, is_deleted) on public.leads to authenticated;

create function private.stamp_lead() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  new.version := old.version + 1;
  return new;
end;
$$;
revoke all on function private.stamp_lead() from public;
create trigger stamp_lead before update on public.leads
  for each row execute function private.stamp_lead();

create function public.create_workspace(team_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); team uuid;
begin
  if actor is null then raise exception 'Сначала войдите в аккаунт.'; end if;
  -- Serializes create/join for one account, including two concurrent devices.
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select workspace_id into team from public.workspace_members where user_id = actor;
  if team is not null then return team; end if;
  if length(trim(team_name)) not between 1 and 100 or team_name is null then
    raise exception 'Название команды должно содержать от 1 до 100 символов.';
  end if;
  insert into public.workspaces(name, owner_id) values(trim(team_name), actor) returning id into team;
  insert into public.workspace_members(workspace_id, user_id) values(team, actor);
  return team;
end;
$$;

create function public.join_workspace(invite text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); team uuid; existing_team uuid;
begin
  if actor is null then raise exception 'Сначала войдите в аккаунт.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  -- Lock this team before counting members: a concurrent third join must fail.
  select id into team from public.workspaces where invite_code = lower(trim(invite)) for update;
  if team is null then raise exception 'Код команды не найден.'; end if;
  select workspace_id into existing_team from public.workspace_members where user_id = actor;
  if existing_team = team then return team; end if;
  if existing_team is not null then raise exception 'Вы уже состоите в другой команде.'; end if;
  if (select count(*) from public.workspace_members where workspace_id = team) >= 2 then
    raise exception 'В этой команде уже два участника.';
  end if;
  insert into public.workspace_members(workspace_id, user_id) values(team, actor);
  return team;
end;
$$;
revoke all on function public.create_workspace(text), public.join_workspace(text) from public, anon;
grant execute on function public.create_workspace(text), public.join_workspace(text) to authenticated;

alter publication supabase_realtime add table public.leads;
commit;

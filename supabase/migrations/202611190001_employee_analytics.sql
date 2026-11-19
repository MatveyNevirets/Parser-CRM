begin;

-- The public card history stays shared, but sender IDs are private.
alter publication supabase_realtime drop table public.lead_outreach;
revoke select on public.lead_outreach from authenticated;
grant select (id, workspace_id, lead_id, kind, occurred_at) on public.lead_outreach to authenticated;
-- Clients confirm sending through mark_mailing_message, which locks and checks the lead.
revoke execute on function public.log_lead_outreach(uuid, uuid, text) from public, anon, authenticated;
create index lead_outreach_activity_time on public.lead_outreach(workspace_id, occurred_at)
  where kind = 'telegram_message';
create index lead_outreach_activity_actor on public.lead_outreach(workspace_id, created_by, occurred_at)
  where kind = 'telegram_message';

create table private.crm_earnings (
  id uuid primary key,
  workspace_id uuid not null,
  user_id uuid not null,
  amount_kopecks bigint not null check (amount_kopecks between 1 and 10000000000),
  earned_on date not null check (isfinite(earned_on)),
  comment text not null default '' check (length(comment) <= 1000),
  lead_id uuid,
  created_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now(),
  version integer not null default 1,
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, id)
);
create index crm_earnings_employee on private.crm_earnings(workspace_id, user_id, earned_on desc, id);
alter table private.crm_earnings enable row level security;
revoke all on private.crm_earnings from public, anon, authenticated;

create table private.crm_outreach_reconciliation (
  workspace_id uuid primary key references public.workspaces(id),
  cutoff timestamptz not null check (isfinite(cutoff)),
  confirmed_total integer not null check (confirmed_total = 55),
  recorded_at_apply integer not null check (recorded_at_apply between 0 and 55),
  evidence text not null check (length(evidence) <= 1000),
  confirmed_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null default now()
);
alter table private.crm_outreach_reconciliation enable row level security;
revoke all on private.crm_outreach_reconciliation from public, anon, authenticated;

-- A team-scoped refresh signal carries neither actor nor financial data.
create table public.crm_activity_updates (
  workspace_id uuid primary key references public.workspaces(id),
  changed_at timestamptz not null default clock_timestamp()
);
alter table public.crm_activity_updates enable row level security;
create policy crm_activity_updates_read on public.crm_activity_updates for select to authenticated
  using (private.is_member(workspace_id));
revoke all on public.crm_activity_updates from public, anon, authenticated;
grant select on public.crm_activity_updates to authenticated;
alter publication supabase_realtime add table public.crm_activity_updates;

create function private.touch_crm_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.crm_activity_updates(workspace_id) values (new.workspace_id)
    on conflict (workspace_id) do update set changed_at = clock_timestamp();
  return new;
end;
$$;
create trigger touch_outreach_activity after insert on public.lead_outreach
  for each row execute function private.touch_crm_activity();
create trigger touch_earnings_activity after insert or update on private.crm_earnings
  for each row execute function private.touch_crm_activity();
create trigger touch_reconciled_activity after insert on private.crm_outreach_reconciliation
  for each row execute function private.touch_crm_activity();

create function private.crm_require_member(team uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.is_member(team), false) then
    raise exception 'Нет доступа к команде.' using errcode = '42501';
  end if;
end;
$$;

create function private.crm_is_owner(team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspaces where id = team and owner_id = auth.uid());
$$;

create function private.crm_require_owner(team uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.crm_require_member(team);
  if not private.crm_is_owner(team) then
    raise exception 'Действие доступно администратору.' using errcode = '42501';
  end if;
end;
$$;

create function private.crm_periods()
returns table (today date, week_start date, month_start date, year_start date, zone text)
language sql stable set search_path = '' as $$
  select local_day, date_trunc('week', local_day::timestamp)::date,
    date_trunc('month', local_day::timestamp)::date, date_trunc('year', local_day::timestamp)::date, 'Europe/Volgograd'
  from (select (now() at time zone 'Europe/Volgograd')::date as local_day) clock;
$$;

create function private.crm_activity(team uuid, employee uuid, include_earnings boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  calendar record;
  message_counts jsonb;
  daily jsonb;
  hourly jsonb;
  earnings jsonb;
begin
  select * into calendar from private.crm_periods();
  with events as materialized (
    select e.occurred_at
    from public.lead_outreach e
    where e.workspace_id = team and e.kind = 'telegram_message'
      and (employee is null or e.created_by = employee)
  ), recent as materialized (
    select e.occurred_at at time zone calendar.zone as local_at from events e
    where e.occurred_at >= (least(calendar.today - 364, calendar.year_start)::timestamp at time zone calendar.zone)
  ), days as (
    select local_at::date as calendar_day, count(*) as amount from recent
    where local_at::date <= calendar.today group by local_at::date
  ), hours as (
    select extract(hour from local_at)::integer as hour_slot, count(*) as amount from recent
    where local_at::date = calendar.today group by extract(hour from local_at)
  )
  select jsonb_build_object(
      'day', coalesce(sum(amount) filter (where calendar_day = calendar.today), 0),
      'week', coalesce(sum(amount) filter (where calendar_day >= calendar.week_start), 0),
      'month', coalesce(sum(amount) filter (where calendar_day >= calendar.month_start), 0),
      'year', coalesce(sum(amount) filter (where calendar_day >= calendar.year_start), 0),
      'total', (select count(*) from events)),
    coalesce(jsonb_object_agg(calendar_day, amount), '{}'::jsonb),
    coalesce((select jsonb_object_agg(hour_slot, amount) from hours), '{}'::jsonb)
  into message_counts, daily, hourly from days;

  if include_earnings then
    select jsonb_build_object(
      'day', coalesce(sum(amount_kopecks) filter (where earned_on = calendar.today), 0),
      'week', coalesce(sum(amount_kopecks) filter (where earned_on between calendar.week_start and calendar.today), 0),
      'month', coalesce(sum(amount_kopecks) filter (where earned_on between calendar.month_start and calendar.today), 0),
      'year', coalesce(sum(amount_kopecks) filter (where earned_on between calendar.year_start and calendar.today), 0),
      'total', coalesce(sum(amount_kopecks), 0),
      'daily', coalesce((select jsonb_object_agg(calendar_day, amount) from (
        select earned_on as calendar_day, sum(amount_kopecks) amount from private.crm_earnings
        where workspace_id = team and (employee is null or user_id = employee)
          and earned_on between calendar.year_start and calendar.today group by earned_on
      ) sums), '{}'::jsonb)
    ) into earnings from private.crm_earnings
    where workspace_id = team and (employee is null or user_id = employee);
  end if;
  return jsonb_build_object('today', calendar.today, 'week_start', calendar.week_start, 'zone', calendar.zone,
    'counts', message_counts, 'daily', daily, 'hourly', hourly, 'earnings', earnings);
end;
$$;

create function public.crm_employee_activity(p_workspace_id uuid, p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare profile jsonb;
begin
  perform private.crm_require_member(p_workspace_id);
  if p_user_id is distinct from auth.uid() then
    perform private.crm_require_owner(p_workspace_id);
  end if;
  select jsonb_build_object('id', u.id, 'login', coalesce(nullif(u.email, ''), nullif(u.phone, ''), 'Аккаунт'),
    'created_at', u.created_at, 'is_admin', w.owner_id = u.id)
    into profile
  from public.workspace_members m join auth.users u on u.id = m.user_id
    join public.workspaces w on w.id = m.workspace_id
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
  if not found then raise exception 'Сотрудник не найден в команде.' using errcode = '42501'; end if;
  return private.crm_activity(p_workspace_id, p_user_id, true) || jsonb_build_object('profile', profile);
end;
$$;

create function public.crm_team_activity(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  report jsonb;
  reconciliation jsonb;
begin
  perform private.crm_require_member(p_workspace_id);
  report := private.crm_activity(p_workspace_id, null, private.crm_is_owner(p_workspace_id));
  select jsonb_build_object('cutoff', r.cutoff, 'additional', greatest(0, r.confirmed_total - (
    select count(*) from public.lead_outreach o where o.workspace_id = p_workspace_id
      and o.kind = 'telegram_message' and o.occurred_at <= r.cutoff
  ))) into reconciliation from private.crm_outreach_reconciliation r where r.workspace_id = p_workspace_id;
  return report || jsonb_build_object('reconciliation', reconciliation);
end;
$$;

create function public.crm_team_members(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.crm_require_owner(p_workspace_id);
  with outreach as (
    select o.created_by, count(*) as total, max(o.occurred_at) as last_activity,
      count(*) filter (where o.occurred_at >= (p.today::timestamp at time zone p.zone)
        and o.occurred_at < ((p.today + 1)::timestamp at time zone p.zone)) as today
    from public.lead_outreach o cross join private.crm_periods() p
    where o.workspace_id = p_workspace_id and o.kind = 'telegram_message' group by o.created_by
  ), earnings as (
    select user_id, sum(amount_kopecks) as total from private.crm_earnings
    where workspace_id = p_workspace_id group by user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'login', coalesce(nullif(u.email, ''), nullif(u.phone, ''), 'Аккаунт'),
      'today', coalesce(o.today, 0), 'total', coalesce(o.total, 0),
      'earnings', coalesce(e.total, 0), 'last_activity', o.last_activity)), '[]'::jsonb)
    into result
  from public.workspace_members m join auth.users u on u.id = m.user_id
    left join outreach o on o.created_by = u.id left join earnings e on e.user_id = u.id
  where m.workspace_id = p_workspace_id;
  return result;
end;
$$;

create function public.crm_earnings_history(p_workspace_id uuid, p_user_id uuid, p_offset integer default 0)
returns table(id uuid, amount_kopecks bigint, earned_on date, comment text, lead_id uuid, company_name text, version integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.crm_require_member(p_workspace_id);
  if p_user_id is distinct from auth.uid() then perform private.crm_require_owner(p_workspace_id); end if;
  return query select e.id, e.amount_kopecks, e.earned_on, e.comment, e.lead_id, l.company_name, e.version
    from private.crm_earnings e left join public.leads l on l.id = e.lead_id and l.workspace_id = e.workspace_id
    where e.workspace_id = p_workspace_id and e.user_id = p_user_id
    order by e.earned_on desc, e.id limit 26 offset greatest(p_offset, 0);
end;
$$;

create function public.crm_save_earning(
  p_workspace_id uuid, p_user_id uuid, p_id uuid, p_version integer,
  p_amount_kopecks bigint, p_earned_on date, p_comment text, p_lead_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare saved private.crm_earnings;
begin
  perform private.crm_require_owner(p_workspace_id);
  if not exists(select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id)
    or (p_lead_id is not null and not exists(select 1 from public.leads where workspace_id = p_workspace_id and id = p_lead_id)) then
    raise exception 'Сотрудник или карточка не найдены в команде.' using errcode = '42501';
  end if;
  if p_amount_kopecks is null or p_amount_kopecks not between 1 and 10000000000
    or p_earned_on is null or not isfinite(p_earned_on)
    or p_earned_on > (select today from private.crm_periods())
    or length(coalesce(p_comment, '')) > 1000 then
    raise exception 'Проверьте сумму, дату и комментарий начисления.' using errcode = '22023';
  end if;
  if p_version is null then
    insert into private.crm_earnings(id, workspace_id, user_id, amount_kopecks, earned_on, comment, lead_id, created_by)
      values (p_id, p_workspace_id, p_user_id, p_amount_kopecks, p_earned_on, coalesce(p_comment, ''), p_lead_id, auth.uid())
    on conflict (id) do nothing;
    if found then return; end if;
  end if;
  select * into saved from private.crm_earnings
    where id = p_id and workspace_id = p_workspace_id and user_id = p_user_id for update;
  if not found then raise exception 'Начисление недоступно.' using errcode = '42501'; end if;
  if saved.amount_kopecks = p_amount_kopecks and saved.earned_on = p_earned_on
    and saved.comment = coalesce(p_comment, '') and saved.lead_id is not distinct from p_lead_id then
    return;
  end if;
  if saved.version is distinct from p_version then
    raise exception 'Начисление уже изменилось. Обновите историю перед редактированием.';
  end if;
  update private.crm_earnings set amount_kopecks = p_amount_kopecks, earned_on = p_earned_on, comment = coalesce(p_comment, ''),
    lead_id = p_lead_id, changed_at = now(), version = version + 1 where id = p_id;
end;
$$;

create function public.crm_reconcile_mailing(
  p_workspace_id uuid, p_cutoff timestamp, p_expected_recorded integer default null, p_evidence text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cutoff_at timestamptz := p_cutoff at time zone 'Europe/Volgograd';
  recorded integer;
  previous private.crm_outreach_reconciliation;
  evidence_note text := trim(coalesce(p_evidence, ''));
begin
  perform private.crm_require_owner(p_workspace_id);
  if cutoff_at is null or not isfinite(cutoff_at) or cutoff_at > clock_timestamp() then
    raise exception 'Укажите дату и время окончания исторического периода.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('outreach-reconciliation:' || p_workspace_id::text, 0));
  select * into previous from private.crm_outreach_reconciliation where workspace_id = p_workspace_id;
  if previous.cutoff is not null and previous.cutoff <> cutoff_at then
    raise exception 'Историческая сверка для этой команды уже сохранена.';
  end if;
  select count(*) into recorded from public.lead_outreach
    where workspace_id = p_workspace_id and kind = 'telegram_message' and occurred_at <= cutoff_at;
  if p_expected_recorded is not null and previous.cutoff is null then
    if recorded <> p_expected_recorded then raise exception 'Число событий изменилось. Выполните проверку снова.'; end if;
    if recorded > 55 then
      raise exception 'В базе уже больше 55 отправок за выбранный период.';
    end if;
    if length(evidence_note) > 1000 or (recorded < 39 and length(evidence_note) < 5) then
      raise exception 'Укажите источник, подтверждающий исходный итог 55.';
    end if;
    insert into private.crm_outreach_reconciliation(workspace_id, cutoff, confirmed_total, recorded_at_apply, confirmed_by, evidence)
      values (p_workspace_id, cutoff_at, 55, recorded, auth.uid(), evidence_note);
  end if;
  return jsonb_build_object('recorded', recorded, 'additional', greatest(0, 55 - recorded),
    'applied', previous.cutoff is not null or p_expected_recorded is not null);
end;
$$;

revoke all on function private.touch_crm_activity(), private.crm_require_member(uuid), private.crm_is_owner(uuid),
  private.crm_require_owner(uuid), private.crm_periods(), private.crm_activity(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.crm_employee_activity(uuid, uuid), public.crm_team_activity(uuid),
  public.crm_team_members(uuid), public.crm_earnings_history(uuid, uuid, integer),
  public.crm_save_earning(uuid, uuid, uuid, integer, bigint, date, text, uuid),
  public.crm_reconcile_mailing(uuid, timestamp, integer, text) from public, anon, authenticated;
grant execute on function public.crm_employee_activity(uuid, uuid), public.crm_team_activity(uuid),
  public.crm_team_members(uuid), public.crm_earnings_history(uuid, uuid, integer),
  public.crm_save_earning(uuid, uuid, uuid, integer, bigint, date, text, uuid),
  public.crm_reconcile_mailing(uuid, timestamp, integer, text) to authenticated;

commit;

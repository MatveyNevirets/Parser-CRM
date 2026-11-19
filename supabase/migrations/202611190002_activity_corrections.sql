begin;

create table private.crm_activity_corrections (
  id uuid primary key,
  workspace_id uuid not null,
  user_id uuid not null,
  hour_start timestamptz not null,
  delta integer not null check (delta between -10000 and 10000 and delta <> 0),
  reason text not null check (length(reason) between 1 and 1000),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id)
);
create index crm_activity_corrections_employee on private.crm_activity_corrections(workspace_id, user_id, hour_start);
alter table private.crm_activity_corrections enable row level security;
revoke all on private.crm_activity_corrections from public, anon, authenticated;
create trigger touch_corrected_activity after insert on private.crm_activity_corrections
  for each row execute function private.touch_crm_activity();

alter table private.crm_earnings drop constraint crm_earnings_amount_kopecks_check;
alter table private.crm_earnings add constraint crm_earnings_amount_kopecks_check
  check (amount_kopecks between 0 and 10000000000);

create function private.crm_activity_facts(team uuid, employee uuid)
returns table (occurred_at timestamptz, created_by uuid, amount integer, is_event boolean)
language sql stable set search_path = '' as $$
  select o.occurred_at, o.created_by, 1, true from public.lead_outreach o
    where o.workspace_id = team and o.kind = 'telegram_message' and (employee is null or o.created_by = employee)
  union all
  select c.hour_start, c.user_id, c.delta, false from private.crm_activity_corrections c
    where c.workspace_id = team and (employee is null or c.user_id = employee);
$$;
revoke all on function private.crm_activity_facts(uuid, uuid) from public, anon, authenticated;

create function public.crm_add_activity_correction(p_workspace_id uuid, p_user_id uuid, p_id uuid,
  p_hour timestamp, p_delta integer, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  chosen_hour timestamptz := p_hour at time zone 'Europe/Volgograd';
  rationale text := trim(coalesce(p_reason, ''));
  previous private.crm_activity_corrections;
  current_count bigint;
begin
  perform private.crm_require_owner(p_workspace_id);
  if not exists(select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id) then
    raise exception 'Сотрудник не найден в команде.' using errcode = '42501';
  end if;
  if p_id is null or p_hour is null or not isfinite(p_hour) or p_hour <> date_trunc('hour', p_hour)
    or chosen_hour > clock_timestamp() or p_delta is null or p_delta = 0
    or p_delta not between -10000 and 10000 or length(rationale) not between 1 and 1000 then
    raise exception 'Проверьте дату, час, число рассылок и причину корректировки.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm-activity-correction:' || p_user_id::text, 0));
  select * into previous from private.crm_activity_corrections where id = p_id;
  if found then
    if previous.workspace_id = p_workspace_id and previous.user_id = p_user_id
      and previous.hour_start = chosen_hour and previous.delta = p_delta and previous.reason = rationale then return; end if;
    raise exception 'Эта корректировка уже сохранена с другими данными.';
  end if;
  select coalesce(sum(f.amount), 0) into current_count from private.crm_activity_facts(p_workspace_id, p_user_id) f
    where f.occurred_at >= chosen_hour and f.occurred_at < chosen_hour + interval '1 hour';
  if current_count + p_delta < 0 then raise exception 'Количество рассылок за выбранный час не может быть отрицательным.'; end if;
  insert into private.crm_activity_corrections(id, workspace_id, user_id, hour_start, delta, reason, created_by)
    values (p_id, p_workspace_id, p_user_id, chosen_hour, p_delta, rationale, auth.uid());
end;
$$;

create function public.crm_activity_correction_history(p_workspace_id uuid, p_user_id uuid)
returns table (id uuid, hour_start timestamptz, delta integer, reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.crm_require_owner(p_workspace_id);
  return query select c.id, c.hour_start, c.delta, c.reason, c.created_at from private.crm_activity_corrections c
    where c.workspace_id = p_workspace_id and c.user_id = p_user_id
    order by c.created_at desc, c.id limit 25;
end;
$$;

revoke all on function public.crm_add_activity_correction(uuid, uuid, uuid, timestamp, integer, text),
  public.crm_activity_correction_history(uuid, uuid) from public, anon, authenticated;
grant execute on function public.crm_add_activity_correction(uuid, uuid, uuid, timestamp, integer, text),
  public.crm_activity_correction_history(uuid, uuid) to authenticated;

create or replace function private.crm_activity(team uuid, employee uuid, include_earnings boolean) returns jsonb
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
    select * from private.crm_activity_facts(team, employee)
  ), recent as materialized (
    select e.occurred_at at time zone calendar.zone as local_at, e.amount from events e
    where e.occurred_at >= (least(calendar.today - 364, calendar.year_start)::timestamp at time zone calendar.zone)
  ), days as (
    select local_at::date as calendar_day, sum(amount) as amount from recent
    where local_at::date <= calendar.today group by local_at::date
  ), hours as (
    select extract(hour from local_at)::integer as hour_slot, sum(amount) as amount from recent
    where local_at::date = calendar.today group by extract(hour from local_at)
  )
  select jsonb_build_object(
      'day', coalesce(sum(amount) filter (where calendar_day = calendar.today), 0),
      'week', coalesce(sum(amount) filter (where calendar_day >= calendar.week_start), 0),
      'month', coalesce(sum(amount) filter (where calendar_day >= calendar.month_start), 0),
      'year', coalesce(sum(amount) filter (where calendar_day >= calendar.year_start), 0),
      'total', (select coalesce(sum(amount), 0) from events)),
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

create or replace function public.crm_team_activity(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  report jsonb;
  reconciliation jsonb;
begin
  perform private.crm_require_member(p_workspace_id);
  report := private.crm_activity(p_workspace_id, null, private.crm_is_owner(p_workspace_id));
  select jsonb_build_object('cutoff', r.cutoff, 'additional', greatest(0, r.confirmed_total - (
    select coalesce(sum(f.amount), 0) from private.crm_activity_facts(p_workspace_id, null) f
    where f.occurred_at <= r.cutoff
  ))) into reconciliation from private.crm_outreach_reconciliation r where r.workspace_id = p_workspace_id;
  return report || jsonb_build_object('reconciliation', reconciliation);
end;
$$;

create or replace function public.crm_team_members(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.crm_require_owner(p_workspace_id);
  with outreach as (
    select f.created_by, sum(f.amount) as total,
      max(f.occurred_at) filter (where f.is_event) as last_activity,
      sum(f.amount) filter (where f.occurred_at >= (p.today::timestamp at time zone p.zone)
        and f.occurred_at < ((p.today + 1)::timestamp at time zone p.zone)) as today
    from private.crm_activity_facts(p_workspace_id, null) f cross join private.crm_periods() p
    group by f.created_by
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

create or replace function public.crm_reconcile_mailing(
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
  select coalesce(sum(f.amount), 0) into recorded
    from private.crm_activity_facts(p_workspace_id, null) f where f.occurred_at <= cutoff_at;
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

create or replace function public.crm_save_earning(
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
  if p_amount_kopecks is null or p_amount_kopecks not between 0 and 10000000000 or (p_version is null and p_amount_kopecks = 0)
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

commit;

begin;

alter table private.crm_activity_corrections add column applies_to_day boolean not null default false;

create function private.crm_activity_facts_with_precision(team uuid, employee uuid)
returns table (occurred_at timestamptz, created_by uuid, amount integer, is_event boolean, is_hourly boolean)
language sql stable set search_path = '' as $$
  select o.occurred_at, o.created_by, 1, true, true from public.lead_outreach o
    where o.workspace_id = team and o.kind = 'telegram_message' and (employee is null or o.created_by = employee)
  union all
  select c.hour_start, c.user_id, c.delta, false, not c.applies_to_day from private.crm_activity_corrections c
    where c.workspace_id = team and (employee is null or c.user_id = employee);
$$;

create or replace function private.crm_activity_facts(team uuid, employee uuid)
returns table (occurred_at timestamptz, created_by uuid, amount integer, is_event boolean)
language sql stable set search_path = '' as $$
  select f.occurred_at, f.created_by, f.amount, f.is_event
  from private.crm_activity_facts_with_precision(team, employee) f;
$$;

create function private.crm_apply_activity_correction(p_workspace_id uuid, p_user_id uuid, p_id uuid,
  p_hour timestamp, p_delta integer, p_reason text, day_only boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  chosen_hour timestamptz := p_hour at time zone 'Europe/Volgograd';
  day_begin timestamptz := p_hour::date::timestamp at time zone 'Europe/Volgograd';
  day_end timestamptz := (p_hour::date + 1)::timestamp at time zone 'Europe/Volgograd';
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
    raise exception 'Проверьте дату и число рассылок.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm-activity-correction:' || p_user_id::text, 0));
  select * into previous from private.crm_activity_corrections where id = p_id;
  if found then
    if previous.workspace_id = p_workspace_id and previous.user_id = p_user_id
      and previous.applies_to_day = day_only and previous.hour_start = chosen_hour and previous.delta = p_delta and previous.reason = rationale then return; end if;
    raise exception 'Эта корректировка уже сохранена с другими данными.';
  end if;
  if not day_only then
    select coalesce(sum(f.amount), 0) into current_count from private.crm_activity_facts_with_precision(p_workspace_id, p_user_id) f
      where f.is_hourly and f.occurred_at >= chosen_hour and f.occurred_at < chosen_hour + interval '1 hour';
    if current_count + p_delta < 0 then raise exception 'Количество рассылок за выбранный час не может быть отрицательным.'; end if;
  end if;
  select coalesce(sum(f.amount), 0) into current_count from private.crm_activity_facts(p_workspace_id, p_user_id) f
    where f.occurred_at >= day_begin and f.occurred_at < day_end;
  if current_count + p_delta < 0 then raise exception 'Количество рассылок за выбранный день не может быть отрицательным.'; end if;
  insert into private.crm_activity_corrections(id, workspace_id, user_id, hour_start, delta, reason, created_by, applies_to_day)
    values (p_id, p_workspace_id, p_user_id, chosen_hour, p_delta, rationale, auth.uid(), day_only);
end;
$$;

create or replace function public.crm_add_activity_correction(p_workspace_id uuid, p_user_id uuid, p_id uuid,
  p_hour timestamp, p_delta integer, p_reason text) returns void
language sql security definer set search_path = '' as $$
  select private.crm_apply_activity_correction(p_workspace_id, p_user_id, p_id, p_hour, p_delta, p_reason, false);
$$;

create function public.crm_add_daily_activity_correction(p_workspace_id uuid, p_user_id uuid, p_id uuid,
  p_date date, p_delta integer) returns void
language sql security definer set search_path = '' as $$
  select private.crm_apply_activity_correction(p_workspace_id, p_user_id, p_id, p_date::timestamp, p_delta, 'Daily adjustment', true);
$$;

revoke all on function private.crm_activity_facts_with_precision(uuid, uuid),
  private.crm_apply_activity_correction(uuid, uuid, uuid, timestamp, integer, text, boolean),
  public.crm_add_daily_activity_correction(uuid, uuid, uuid, date, integer) from public, anon, authenticated;
grant execute on function public.crm_add_daily_activity_correction(uuid, uuid, uuid, date, integer) to authenticated;

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
    select * from private.crm_activity_facts_with_precision(team, employee)
  ), recent as materialized (
    select e.occurred_at at time zone calendar.zone as local_at, e.amount, e.is_hourly from events e
    where e.occurred_at >= (least(calendar.today - 364, calendar.year_start)::timestamp at time zone calendar.zone)
  ), days as (
    select local_at::date as calendar_day, sum(amount) as amount from recent
    where local_at::date <= calendar.today group by local_at::date
  ), hours as (
    select extract(hour from local_at)::integer as hour_slot, sum(amount) as amount from recent
    where is_hourly and local_at::date = calendar.today group by extract(hour from local_at)
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

commit;

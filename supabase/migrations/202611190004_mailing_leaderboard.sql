begin;

create function public.crm_mailing_leaderboard(p_workspace_id uuid, p_on date, p_period text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  calendar record;
  period_start date;
  period_end date;
  result jsonb;
begin
  perform private.crm_require_owner(p_workspace_id);
  select * into calendar from private.crm_periods();
  if p_on is null or not isfinite(p_on) or p_on > calendar.today
    or p_period is null or p_period not in ('day', 'week', 'month') then
    raise exception 'Выберите день, неделю или месяц до текущей даты включительно.' using errcode = '22023';
  end if;

  period_start := date_trunc(p_period, p_on::timestamp)::date;
  period_end := case p_period
    when 'day' then period_start + 1
    when 'week' then period_start + 7
    else (period_start + interval '1 month')::date
  end;

  with daily as (
    select f.created_by, (f.occurred_at at time zone calendar.zone)::date as activity_date, sum(f.amount) as amount
    from private.crm_activity_facts(p_workspace_id, null) f
    where f.occurred_at >= (period_start::timestamp at time zone calendar.zone)
      and f.occurred_at < (least(period_end, calendar.today + 1)::timestamp at time zone calendar.zone)
    group by f.created_by, activity_date
  ), totals as (
    select created_by, sum(amount) as total, jsonb_object_agg(activity_date, amount) as daily
    from daily group by created_by
  ), ranked as (
    select u.id, coalesce(nullif(u.email, ''), nullif(u.phone, ''), 'Аккаунт') as login,
      coalesce(t.total, 0) as total, coalesce(t.daily, '{}'::jsonb) as daily,
      rank() over (order by coalesce(t.total, 0) desc) as position
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join totals t on t.created_by = m.user_id
    where m.workspace_id = p_workspace_id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.position, lower(r.login), r.id), '[]'::jsonb)
  into result from ranked r;

  return jsonb_build_object('start', period_start, 'end', period_end - 1, 'members', result);
end;
$$;

revoke all on function public.crm_mailing_leaderboard(uuid, date, text) from public, anon, authenticated;
grant execute on function public.crm_mailing_leaderboard(uuid, date, text) to authenticated;

commit;

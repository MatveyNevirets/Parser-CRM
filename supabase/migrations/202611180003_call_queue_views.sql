begin;

alter table public.leads add column excluded_from_automatic_calls boolean not null default false;
grant update (excluded_from_automatic_calls) on public.leads to authenticated;

-- A later status change makes the lead eligible for automatic calls again.
create function private.reset_automatic_call_exclusion() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.excluded_from_automatic_calls := false;
  return new;
end;
$$;
revoke all on function private.reset_automatic_call_exclusion() from public, anon, authenticated;
create trigger reset_automatic_call_exclusion before update of status on public.leads
  for each row when (old.status is distinct from new.status)
  execute function private.reset_automatic_call_exclusion();

create or replace function public.crm_sales_statistics(p_workspace_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with leads as (
    select id, status, priority, archived_at, manually_queued_for_calls, excluded_from_automatic_calls
    from public.leads where workspace_id = p_workspace_id and not is_deleted
  ), queues as (
    select *, archived_at is null and (manually_queued_for_calls
      or (status = 'waiting' and not excluded_from_automatic_calls)) as in_calls
    from leads
  ), calls as (
    select c.lead_id, c.outcome, c.occurred_at, c.created_at, c.id
    from public.lead_calls c join leads l on l.id = c.lead_id
    where c.workspace_id = p_workspace_id and c.outcome is not null
  ), latest_call as (
    select distinct on (lead_id) lead_id, outcome from calls
    order by lead_id, occurred_at desc, created_at desc, id
  ), outreach as (
    select o.lead_id, o.kind from public.lead_outreach o join leads l on l.id = o.lead_id
    where o.workspace_id = p_workspace_id
  )
  select jsonb_build_object(
    'total', count(*) filter (where archived_at is null and priority = 'normal' and status = 'newLead'),
    'mailing', count(*) filter (where archived_at is null and not in_calls),
    'calls_queue', count(*) filter (where in_calls),
    'archived', count(*) filter (where archived_at is not null),
    'rejected_or_hidden', count(*) filter (where archived_at is not null or status = 'rejected'
      or id in (select lead_id from latest_call where outcome = 'rejected')),
    'messaged', (select count(distinct lead_id) from outreach),
    'offers', (select count(*) from outreach where kind = 'telegram_offer')
      + (select count(*) from calls where outcome = 'offer_sent'),
    'waiting', count(*) filter (where status = 'waiting'),
    'calls_made', (select count(*) from calls),
    'interested', (select count(distinct lead_id) from calls where outcome = 'interested')
  ) from queues;
$$;

commit;

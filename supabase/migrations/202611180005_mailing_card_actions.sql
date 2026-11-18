begin;

update public.leads
set status = 'inProgress'
where status in ('contacted', 'qualified');

alter table public.leads drop constraint leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('newLead', 'inProgress', 'waiting', 'offer', 'rejected'));

create or replace function public.mark_mailing_message(p_lead_id uuid, p_id uuid, p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  lead public.leads;
  actor uuid := auth.uid();
begin
  select * into lead from public.leads where id = p_lead_id for update;
  if not found or actor is null or not private.is_member(lead.workspace_id) then
    raise exception 'Карточка недоступна.' using errcode = '42501';
  end if;
  if exists (select 1 from public.lead_outreach where id = p_id and lead_id = p_lead_id
    and created_by = actor and kind = 'telegram_message') then
    return;
  end if;
  if lead.version is distinct from p_version or lead.is_deleted or lead.archived_at is not null
    or lead.status <> 'newLead' or lead.priority <> 'normal' or lead.manually_queued_for_calls then
    raise exception 'Карточка изменилась или вышла из рассылки. Обновите список и откройте её снова.';
  end if;
  perform public.log_lead_outreach(p_lead_id, p_id, 'telegram_message');
  update public.leads set status = 'inProgress' where id = p_lead_id;
end;
$$;

revoke all on function public.mark_mailing_message(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.mark_mailing_message(uuid, uuid, integer) to authenticated;

commit;

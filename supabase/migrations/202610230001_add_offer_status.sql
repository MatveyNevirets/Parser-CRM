-- Extend the existing CHECK without rewriting or deleting lead records.
-- Transactional and safe to run again; requires the original team CRM migration.
begin;

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('newLead', 'inProgress', 'waiting', 'contacted', 'qualified', 'offer', 'rejected')) not valid;
alter table public.leads validate constraint leads_status_check;

commit;

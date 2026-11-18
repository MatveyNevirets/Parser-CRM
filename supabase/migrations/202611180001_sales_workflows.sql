begin;

alter table public.leads
  add column archived_at timestamptz,
  add column manually_queued_for_calls boolean not null default false,
  add constraint leads_workspace_id_key unique (workspace_id, id);
grant update (archived_at, manually_queued_for_calls) on public.leads to authenticated;

create table public.lead_calls (
  id uuid primary key,
  workspace_id uuid not null,
  lead_id uuid not null,
  created_by uuid not null references auth.users(id),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  outcome text check (outcome in ('no_answer', 'rejected', 'interested', 'call_later', 'offer_sent')),
  went_well text not null check (length(went_well) <= 10000),
  went_poorly text not null check (length(went_poorly) <= 10000),
  notes text not null check (length(notes) <= 10000),
  audio_duration_seconds integer check (audio_duration_seconds between 0 and 86400),
  audio_mime text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, id)
);
create index lead_calls_lead_history on public.lead_calls(lead_id, occurred_at desc, id);
create index lead_calls_workspace_outcome on public.lead_calls(workspace_id, outcome, lead_id);

-- Binary data is fetched on demand and never appears in history or Realtime.
create table private.lead_call_audio (
  call_id uuid primary key references public.lead_calls(id) on delete cascade,
  content bytea not null check (octet_length(content) between 12 and 8388608)
);

create table public.lead_outreach (
  id uuid primary key,
  workspace_id uuid not null,
  lead_id uuid not null,
  created_by uuid not null references auth.users(id),
  kind text not null check (kind in ('telegram_message', 'telegram_offer')),
  occurred_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, id)
);
create index lead_outreach_lead_history on public.lead_outreach(lead_id, occurred_at desc, id);
create index lead_outreach_workspace_kind on public.lead_outreach(workspace_id, kind, lead_id);

alter table public.lead_calls enable row level security;
alter table public.lead_outreach enable row level security;
alter table private.lead_call_audio enable row level security;
create policy lead_calls_read on public.lead_calls for select to authenticated
  using (private.is_member(workspace_id));
create policy lead_outreach_read on public.lead_outreach for select to authenticated
  using (private.is_member(workspace_id));
revoke all on public.lead_calls, public.lead_outreach, private.lead_call_audio from public, anon, authenticated;
grant select on public.lead_calls, public.lead_outreach to authenticated;

create function private.checked_call_audio(p_mime text, p_base64 text) returns bytea
language plpgsql immutable set search_path = '' as $$
declare
  content bytea;
begin
  if p_base64 is null or length(p_base64) > 11184812 then
    raise exception 'Допустимый размер аудио — до 8 МБ.' using errcode = '22023';
  end if;
  content := decode(p_base64, 'base64');
  if octet_length(content) not between 12 and 8388608 or not coalesce(case p_mime
    when 'audio/webm' then substring(content for 4) = decode('1a45dfa3', 'hex')
    when 'audio/ogg' then substring(content for 4) = decode('4f676753', 'hex')
    when 'audio/mp4' then substring(content from 5 for 4) = decode('66747970', 'hex')
    when 'audio/wav' then substring(content for 4) = decode('52494646', 'hex')
      and substring(content from 9 for 4) = decode('57415645', 'hex')
    when 'audio/mpeg' then substring(content for 3) = decode('494433', 'hex')
      or (get_byte(content, 0) = 255 and (get_byte(content, 1) & 224) = 224
          and (get_byte(content, 1) & 6) <> 0)
    else false
  end, false) then
    raise exception 'Содержимое файла не соответствует поддерживаемому формату аудио.' using errcode = '22023';
  end if;
  return content;
end;
$$;

create function public.save_lead_call(
  p_lead_id uuid, p_id uuid, p_occurred_at timestamptz, p_outcome text,
  p_went_well text, p_went_poorly text, p_notes text,
  p_audio_mime text, p_audio_duration integer, p_audio_base64 text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  team uuid;
  inserted uuid;
  audio_content bytea;
begin
  select workspace_id into team from public.leads where id = p_lead_id and not is_deleted for share;
  if not found or auth.uid() is null or not private.is_member(team) then
    raise exception 'Карточка недоступна.' using errcode = '42501';
  end if;
  if (p_audio_mime is null) <> (p_audio_base64 is null)
    or (p_audio_mime is null and p_audio_duration is not null)
    or (p_outcome is null and p_audio_mime is null and
      concat(trim(p_went_well), trim(p_went_poorly), trim(p_notes)) = '') then
    raise exception 'Укажите результат, заметки или прикрепите аудио.' using errcode = '22023';
  end if;
  if p_audio_base64 is not null then
    audio_content := private.checked_call_audio(p_audio_mime, p_audio_base64);
  end if;
  insert into public.lead_calls(id, workspace_id, lead_id, created_by, occurred_at, outcome,
    went_well, went_poorly, notes, audio_mime, audio_duration_seconds)
  values (p_id, team, p_lead_id, auth.uid(), p_occurred_at, p_outcome,
    p_went_well, p_went_poorly, p_notes, p_audio_mime, p_audio_duration)
  on conflict (id) do nothing returning id into inserted;
  if inserted is not null then
    if audio_content is not null then
      insert into private.lead_call_audio(call_id, content) values (p_id, audio_content);
    end if;
  elsif not exists (
    select 1 from public.lead_calls c left join private.lead_call_audio a on a.call_id = c.id
    where c.id = p_id and c.lead_id = p_lead_id and c.created_by = auth.uid()
      and c.occurred_at = p_occurred_at and c.outcome is not distinct from p_outcome
      and c.went_well = p_went_well and c.went_poorly = p_went_poorly and c.notes = p_notes
      and (audio_content is null or (c.audio_mime = p_audio_mime
        and c.audio_duration_seconds is not distinct from p_audio_duration and a.content = audio_content))
  ) then
    raise exception 'Этот звонок уже сохранён с другими данными. Проверьте историю.' using errcode = '23505';
  end if;
end;
$$;

create function public.attach_lead_call_audio(p_call_id uuid, p_mime text, p_duration integer, p_base64 text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  saved public.lead_calls;
  audio_content bytea;
begin
  select * into saved from public.lead_calls where id = p_call_id for update;
  if not found or auth.uid() is null or not private.is_member(saved.workspace_id) then
    raise exception 'Звонок недоступен.' using errcode = '42501';
  end if;
  audio_content := private.checked_call_audio(p_mime, p_base64);
  if saved.audio_mime is not null then
    if saved.audio_mime = p_mime and saved.audio_duration_seconds is not distinct from p_duration
      and exists (select 1 from private.lead_call_audio a where a.call_id = p_call_id and a.content = audio_content) then
      return;
    end if;
    raise exception 'К этому звонку уже прикреплена запись.' using errcode = '23505';
  end if;
  insert into private.lead_call_audio(call_id, content) values (p_call_id, audio_content);
  update public.lead_calls set audio_mime = p_mime, audio_duration_seconds = p_duration where id = p_call_id;
end;
$$;

create function public.get_lead_call_audio(p_call_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(a.content, 'base64')
  from private.lead_call_audio a join public.lead_calls c on c.id = a.call_id
  where c.id = p_call_id and auth.uid() is not null and private.is_member(c.workspace_id);
$$;

create function public.log_lead_outreach(p_lead_id uuid, p_id uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  team uuid;
begin
  select workspace_id into team from public.leads where id = p_lead_id and not is_deleted;
  if not found or auth.uid() is null or not private.is_member(team) then
    raise exception 'Карточка недоступна.' using errcode = '42501';
  end if;
  insert into public.lead_outreach(id, workspace_id, lead_id, created_by, kind)
  values (p_id, team, p_lead_id, auth.uid(), p_kind) on conflict (id) do nothing;
  if not found and not exists (select 1 from public.lead_outreach
    where id = p_id and lead_id = p_lead_id and created_by = auth.uid() and kind = p_kind) then
    raise exception 'Такое действие уже сохранено с другими данными.' using errcode = '23505';
  end if;
end;
$$;

create function public.crm_sales_statistics(p_workspace_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with leads as (
    select id, status, archived_at, manually_queued_for_calls
    from public.leads where workspace_id = p_workspace_id and not is_deleted
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
    'total', count(*),
    'mailing', count(*) filter (where archived_at is null),
    'calls_queue', count(*) filter (where archived_at is null and (manually_queued_for_calls or status = 'waiting')),
    'archived', count(*) filter (where archived_at is not null),
    'rejected_or_hidden', count(*) filter (where archived_at is not null or status = 'rejected'
      or id in (select lead_id from latest_call where outcome = 'rejected')),
    'messaged', (select count(distinct lead_id) from outreach),
    'offers', (select count(*) from outreach where kind = 'telegram_offer')
      + (select count(*) from calls where outcome = 'offer_sent'),
    'waiting', count(*) filter (where status = 'waiting'),
    'calls_made', (select count(*) from calls),
    'interested', (select count(distinct lead_id) from calls where outcome = 'interested')
  ) from leads;
$$;

revoke all on function private.checked_call_audio(text, text) from public, anon, authenticated;
revoke all on function public.save_lead_call(uuid, uuid, timestamptz, text, text, text, text, text, integer, text),
  public.attach_lead_call_audio(uuid, text, integer, text), public.get_lead_call_audio(uuid),
  public.log_lead_outreach(uuid, uuid, text), public.crm_sales_statistics(uuid) from public, anon, authenticated;
grant execute on function public.save_lead_call(uuid, uuid, timestamptz, text, text, text, text, text, integer, text),
  public.attach_lead_call_audio(uuid, text, integer, text), public.get_lead_call_audio(uuid),
  public.log_lead_outreach(uuid, uuid, text), public.crm_sales_statistics(uuid) to authenticated;

alter publication supabase_realtime add table public.lead_calls, public.lead_outreach;
commit;

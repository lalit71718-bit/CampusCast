-- Stage 13: cultural events with posters, AI reading and draft / publish. Safe to re-run.
-- Run after setup.sql, dashboard-1-engine.sql and dashboard-3-official.sql (which created `events`).
-- If dashboard-3 is ever run again, run this file again too (dashboard-3 puts back the older event rules).
--
-- Who posts: an admin, or the admin of a club (club_admins). Nobody else has to approve. The AI only fills in a DRAFT
-- from an uploaded poster; a person always presses Publish. Students see only published (or cancelled) events, and
-- every verified student sees all of them. RSVPs stay "interested" or "going"; only the counts are ever shown.

-- ============================================================
-- 1. More details on events
-- ============================================================
alter table public.events add column if not exists status text not null default 'published';
alter table public.events add column if not exists organizer_name text;      -- when the organiser is not one of the clubs
alter table public.events add column if not exists tagline text;
alter table public.events add column if not exists category text;            -- dance, music, drama, fest ...
alter table public.events add column if not exists ends_at timestamptz;
alter table public.events add column if not exists reg_closes_at timestamptz;
alter table public.events add column if not exists map_url text;
alter table public.events add column if not exists eligibility text;
alter table public.events add column if not exists rules text;
alter table public.events add column if not exists fee_amount numeric(10, 2);  -- null = not stated, 0 = free
alter table public.events add column if not exists fee_note text;
alter table public.events add column if not exists contact_name text;
alter table public.events add column if not exists contact_phone text;
alter table public.events add column if not exists contact_email text;
alter table public.events add column if not exists website_url text;
alter table public.events add column if not exists link text;                  -- the organisers' own registration page, if any
alter table public.events add column if not exists details jsonb not null default '{}';   -- { programme: [], guests: [], prizes: [], extraction: {} }
alter table public.events add column if not exists published_at timestamptz;   -- the first time it was published
alter table public.events add column if not exists told_starts_at timestamptz; -- the time and place students were last shown
alter table public.events add column if not exists told_venue text;
alter table public.events add column if not exists updated_at timestamptz not null default now();

-- A draft read from a poster may not state a date yet. A published or cancelled event must have one.
alter table public.events alter column starts_at drop not null;

-- Events posted before this file count as already announced, so editing one does not alert the club's followers.
update public.events set published_at = created_at, told_starts_at = starts_at, told_venue = venue
  where status = 'published' and published_at is null;

do $$
declare c record;
begin
  for c in select * from (values
    ('events_status_check', $c$check (status in ('draft', 'published', 'cancelled'))$c$),
    ('events_published_needs_date_check', $c$check (status = 'draft' or starts_at is not null)$c$),
    ('events_ends_check', $c$check (status = 'draft' or ends_at is null or ends_at >= starts_at)$c$),
    ('events_fee_check', $c$check (fee_amount is null or fee_amount >= 0)$c$),
    ('events_urls_check', $c$check ((website_url is null or website_url ~* '^https?://') and (map_url is null or map_url ~* '^https?://') and (link is null or link ~* '^https?://'))$c$),
    ('events_contact_check', $c$check ((contact_phone is null or contact_phone ~ '^[0-9+() -]{7,20}$') and (contact_email is null or contact_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$'))$c$),
    ('events_details_check', $c$check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 60000)$c$)
  ) as t(name, body)
  loop
    if not exists (select 1 from pg_constraint where conname = c.name and conrelid = 'public.events'::regclass) then
      execute format('alter table public.events add constraint %I %s', c.name, c.body);
    end if;
  end loop;
end $$;

-- ============================================================
-- 2. Who can see and manage
-- ============================================================
-- May the signed-in user post events at all (an admin, or an admin of at least one club)?
create or replace function public.can_publish_events() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_verified() and exists (select 1 from public.club_admins where user_id = auth.uid()))
$$;
grant execute on function public.can_publish_events() to authenticated;

-- May the signed-in user edit this event? An admin, the admin of its club, or its organiser while they can still post.
create or replace function public.event_manageable(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.events e where e.id = p_id and (
    public.is_admin()
    or (e.club_id is not null and public.can_publish(e.club_id))
    or (e.created_by = auth.uid() and public.can_publish_events())))
$$;
grant execute on function public.event_manageable(uuid) to authenticated;

drop policy if exists "Manage events" on public.events;   -- the older "one rule for everything" from dashboard-3
drop policy if exists "Read events" on public.events;
create policy "Read events" on public.events for select to authenticated using (
  (status in ('published', 'cancelled') and public.is_verified())
  or public.is_admin()
  or (club_id is not null and public.can_publish(club_id))
  or (created_by = auth.uid() and public.can_publish_events())
);
drop policy if exists "Create events" on public.events;
create policy "Create events" on public.events for insert to authenticated
  with check (public.is_admin() or (club_id is not null and public.can_publish(club_id) and created_by = auth.uid()));
drop policy if exists "Edit events" on public.events;
create policy "Edit events" on public.events for update to authenticated
  using (public.is_admin() or (club_id is not null and public.can_publish(club_id)) or (created_by = auth.uid() and public.can_publish_events()))
  with check (public.is_admin() or (club_id is not null and public.can_publish(club_id)));
drop policy if exists "Delete events" on public.events;
create policy "Delete events" on public.events for delete to authenticated
  using (public.is_admin() or (club_id is not null and public.can_publish(club_id)) or (created_by = auth.uid() and public.can_publish_events()));

-- ============================================================
-- 3. RSVPs: only on published events that are not over (no end time = it lasts three hours)
-- ============================================================
drop policy if exists "Own RSVPs" on public.event_rsvps;
create policy "Own RSVPs" on public.event_rsvps for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_verified() and exists (
    select 1 from public.events e where e.id = event_rsvps.event_id and e.status = 'published'
      and now() < coalesce(e.ends_at, e.starts_at + interval '3 hours')));

create or replace function public.event_counts() returns table (event_id uuid, interested integer, going integer)
language sql stable security definer set search_path = public as $$
  select e.id,
         (select count(*)::integer from public.event_rsvps r where r.event_id = e.id and r.status = 'interested'),
         (select count(*)::integer from public.event_rsvps r where r.event_id = e.id and r.status = 'going')
  from public.events e
  where public.event_manageable(e.id) or (e.status in ('published', 'cancelled') and public.is_verified())
$$;
grant execute on function public.event_counts() to authenticated;

-- ============================================================
-- 4. Reminders and alerts
-- ============================================================
create or replace function public.events_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  -- These three are kept by the database; whatever was sent for them is ignored.
  if tg_op = 'INSERT' then
    new.published_at := null; new.told_starts_at := null; new.told_venue := null;
  else
    new.published_at := old.published_at; new.told_starts_at := old.told_starts_at; new.told_venue := old.told_venue;
  end if;
  if new.status = 'published' then
    new.published_at := coalesce(new.published_at, now());
    new.told_starts_at := new.starts_at;
    new.told_venue := new.venue;
  end if;
  return new;
end $$;
drop trigger if exists events_guard on public.events;
create trigger events_guard before insert or update on public.events for each row execute function public.events_guard();

-- Tells the people concerned. First publication: the club's followers, once. Later: students who said interested or
-- going, when it is cancelled or when its time or venue differs from what they were last shown.
create or replace function public.events_alerts() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  link_to text := '/dashboard/events/' || new.id;
  starts text := to_char(new.starts_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM');
  over boolean := coalesce(new.ends_at, new.starts_at + interval '3 hours') <= now();
  heading text; msg text;
begin
  if tg_op = 'UPDATE' then
    -- Taken offline or cancelled: nobody should be reminded about it.
    if new.status <> 'published' and old.status = 'published' then
      delete from public.reminders where kind = 'event' and ref_id = new.id and sent_at is null;
    end if;
    -- New start time: move every unsent reminder by the same amount (those that would now be in the past are dropped).
    if new.status = 'published' and old.status = 'published' then
      if new.starts_at is distinct from old.starts_at then
        with gone as (
          delete from public.reminders where kind = 'event' and ref_id = new.id and sent_at is null returning *
        )
        insert into public.reminders (user_id, kind, ref_id, title, url, remind_at)
        select user_id, kind, ref_id, new.title, url, remind_at + (new.starts_at - old.starts_at) from gone
        where remind_at + (new.starts_at - old.starts_at) > now()
        on conflict do nothing;
      elsif new.title is distinct from old.title then
        update public.reminders set title = new.title where kind = 'event' and ref_id = new.id and sent_at is null;
      end if;
    end if;
  end if;

  if over then return new; end if;

  if new.status = 'published' and (tg_op = 'INSERT' or old.published_at is null) then
    if new.club_id is not null then
      insert into public.notifications (user_id, kind, title, body, url, urgency, ref_id)
      select f.user_id, 'event', 'New event: ' || new.title,
             (select name from public.clubs where id = new.club_id) || ' · ' || starts || coalesce(' · ' || new.venue, ''), link_to, 2, new.id
      from public.club_follows f join public.profiles p on p.id = f.user_id
      where f.club_id = new.club_id and p.status = 'verified' and f.user_id is distinct from auth.uid();
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'cancelled' and old.status <> 'cancelled' and old.published_at is not null then
      heading := 'Cancelled: ' || new.title;
      msg := 'This event will not take place.';
    elsif new.status = 'published' and (new.starts_at is distinct from old.told_starts_at or new.venue is distinct from old.told_venue) then
      heading := 'Changed: ' || new.title;
      msg := 'Now ' || starts || coalesce(' at ' || new.venue, '') || '.';
    end if;
    if heading is not null then
      insert into public.notifications (user_id, kind, title, body, url, urgency, ref_id)
      select r.user_id, 'event', heading, msg, link_to, 1, new.id
      from public.event_rsvps r join public.profiles p on p.id = r.user_id
      where r.event_id = new.id and p.status = 'verified' and r.user_id is distinct from auth.uid();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists events_alerts on public.events;
create trigger events_alerts after insert or update on public.events for each row execute function public.events_alerts();

create or replace function public.events_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.reminders where kind = 'event' and ref_id = old.id and sent_at is null;
  return old;
end $$;
drop trigger if exists events_deleted on public.events;
create trigger events_deleted after delete on public.events for each row execute function public.events_deleted();

create or replace function public.events_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and (tg_op = 'INSERT' or old.status is distinct from new.status) and (new.status <> 'draft' or tg_op = 'UPDATE') then
    perform public.log_audit('event.' || new.status, 'event', new.id::text, jsonb_build_object('title', new.title));
  end if;
  return new;
end $$;
drop trigger if exists events_audit on public.events;
create trigger events_audit after insert or update of status on public.events for each row execute function public.events_audit();

-- ============================================================
-- 5. Posters (PDF or a photo) and what the AI read from them
-- ============================================================
create table if not exists public.event_documents (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  storage_path text not null unique,            -- in the event-files bucket: <uploader id>/<file id>.<ext>
  original_filename text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count smallint check (page_count is null or page_count > 0),
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists event_documents_event_idx on public.event_documents (event_id);
create index if not exists event_documents_sha_idx on public.event_documents (sha256);
alter table public.event_documents enable row level security;

-- Anyone who can read the event can read its documents' rows (so students see the poster of a published one).
drop policy if exists "Read event documents" on public.event_documents;
create policy "Read event documents" on public.event_documents for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_documents.event_id));
drop policy if exists "Add event documents" on public.event_documents;
create policy "Add event documents" on public.event_documents for insert to authenticated
  with check (uploaded_by = auth.uid() and public.event_manageable(event_id)
    and storage_path like auth.uid()::text || '/%');   -- never point an event at somebody else's file
drop policy if exists "Remove event documents" on public.event_documents;
create policy "Remove event documents" on public.event_documents for delete to authenticated
  using (public.event_manageable(event_id));

create table if not exists public.event_extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.event_documents (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  attempt smallint not null default 1,
  error text,
  model text,
  ocr_used boolean not null default false,
  result jsonb,
  field_meta jsonb not null default '{}',
  requires_review boolean not null default true,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists event_extractions_doc_idx on public.event_extractions (document_id, created_at desc);
alter table public.event_extractions enable row level security;

create or replace function public.event_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists event_extractions_touch on public.event_extractions;
create trigger event_extractions_touch before update on public.event_extractions for each row execute function public.event_touch();

create or replace function public.event_document_manageable(p_doc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.event_documents d where d.id = p_doc and public.event_manageable(d.event_id))
$$;
grant execute on function public.event_document_manageable(uuid) to authenticated;

-- Students never see extraction data.
drop policy if exists "Managers read event extractions" on public.event_extractions;
create policy "Managers read event extractions" on public.event_extractions for select to authenticated using (public.event_document_manageable(document_id));
drop policy if exists "Managers start event extractions" on public.event_extractions;
create policy "Managers start event extractions" on public.event_extractions for insert to authenticated with check (public.event_document_manageable(document_id));
drop policy if exists "Managers update event extractions" on public.event_extractions;
create policy "Managers update event extractions" on public.event_extractions for update to authenticated
  using (public.event_document_manageable(document_id)) with check (public.event_document_manageable(document_id));

create or replace function public.event_find_duplicates(p_sha256 text)
returns table (event_id uuid, title text, status text)
language sql stable security definer set search_path = public as $$
  select e.id, e.title, e.status from public.event_documents d join public.events e on e.id = d.event_id
  where d.sha256 = lower(p_sha256) and public.event_manageable(e.id)
$$;
revoke execute on function public.event_find_duplicates(text) from public, anon;
grant execute on function public.event_find_duplicates(text) to authenticated;

-- ============================================================
-- 6. Private storage for the poster files
-- ============================================================
-- Posters added before this file stay where they are (the event-media bucket) and keep showing.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-files', 'event-files', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Organizers upload event files" on storage.objects;
create policy "Organizers upload event files" on storage.objects for insert to authenticated
  with check (bucket_id = 'event-files' and public.can_publish_events() and (storage.foldername(name))[1] = auth.uid()::text);

-- Read: the uploader, or anyone who can read the event the file belongs to (students: published ones).
drop policy if exists "Read event files" on storage.objects;
create policy "Read event files" on storage.objects for select to authenticated
  using (bucket_id = 'event-files' and (
    ((storage.foldername(name))[1] = auth.uid()::text and public.can_publish_events())
    or exists (select 1 from public.event_documents d where d.storage_path = storage.objects.name)
  ));

drop policy if exists "Remove event files" on storage.objects;
create policy "Remove event files" on storage.objects for delete to authenticated
  using (bucket_id = 'event-files' and (
    public.is_admin()
    or ((storage.foldername(name))[1] = auth.uid()::text and public.can_publish_events())
  ));

-- Free mentorship rules: only fourth-year students mentor, only first to third years are mentored. Safe to re-run.
-- Run after setup.sql, dashboard-1 and -4. Run this again if dashboard-4 is ever re-run.
--
--   * The year of study comes from the college email (25ug1byai282@bmsit.in = joined 2025) and today's date,
--     moving everyone up on 1 August. profiles.year (typed in at verification) is not used here.
--   * A super-admin can correct a student's year (lateral entry, year-back, unusual email). Students cannot.
--   * A mentor takes up to 3 mentees; a student has up to 2 open requests; unanswered requests expire in 7 days.
--   * The mentor proposes a time, the mentee confirms it, either side can cancel.
--   * Admins can suspend a mentor, also from a report. Blocking someone ends the mentorship between the two.

-- ============================================================
-- 1. Who is in which year
-- ============================================================
-- 'student' or 'faculty', the same column dashboard-9 adds (and lets a super-admin change). Added here too,
-- so this file also works where Connect profiles are not set up.
alter table public.profiles add column if not exists person_type text not null default 'student';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_person_type_check') then
    alter table public.profiles add constraint profiles_person_type_check check (person_type in ('student', 'faculty'));
  end if;
end $$;

-- Set only by set_study_year() below: the joining year to count from instead of the one in the email.
alter table public.profiles add column if not exists study_batch smallint;

-- The calendar year in which the current academic year began (August, Indian time).
create or replace function public.academic_start_year(p_at timestamptz default now()) returns integer
language sql immutable as $$
  select extract(year from (p_at at time zone 'Asia/Kolkata'))::integer
       - case when extract(month from (p_at at time zone 'Asia/Kolkata')) < 8 then 1 else 0 end
$$;

-- Undergraduate year of study of an ID-verified student (1, 2, 3, 4, or higher once graduated).
-- Null for faculty, postgraduates, unverified accounts and emails we cannot read.
create or replace function public.study_year(p_uid uuid) returns integer
language plpgsql stable security definer set search_path = public as $$
declare p record; mail text; b integer; y integer;
begin
  select status, person_type, study_batch into p from public.profiles where id = p_uid;
  if not found or p.status <> 'verified' or p.person_type <> 'student' then return null; end if;
  select lower(email) into mail from auth.users where id = p_uid;
  if mail ~ '^[0-9]{2}pg1by[a-z]{2}[0-9]{3}@bmsit\.in$' then return null; end if;
  b := coalesce(p.study_batch,
                case when mail ~ '^[0-9]{2}ug1by[a-z]{2}[0-9]{3}@bmsit\.in$' then 2000 + left(mail, 2)::integer end);
  y := public.academic_start_year() - b + 1;
  return case when y >= 1 then y end;
end $$;
revoke execute on function public.study_year(uuid) from public, anon, authenticated;

create table if not exists public.mentor_suspensions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  reason text check (char_length(reason) <= 300),
  suspended_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.mentor_suspensions enable row level security;
drop policy if exists "Read suspensions" on public.mentor_suspensions;
create policy "Read suspensions" on public.mentor_suspensions for select to authenticated using (user_id = auth.uid() or public.is_admin());
-- Written only by suspend_mentor().

-- May this person mentor right now? Fourth year, and not suspended.
create or replace function public.mentor_listed(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.study_year(p_uid) = 4, false)
     and not exists (select 1 from public.mentor_suspensions s where s.user_id = p_uid)
$$;
revoke execute on function public.mentor_listed(uuid) from public, anon;
grant execute on function public.mentor_listed(uuid) to authenticated;

-- May this person be mentored right now? First, second or third year.
create or replace function public.mentee_eligible(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.study_year(p_uid) between 1 and 3, false)
$$;
revoke execute on function public.mentee_eligible(uuid) from public, anon, authenticated;

-- What the signed-in person may do.
create or replace function public.mentorship_status() returns table (study_year integer, can_mentor boolean, can_ask boolean, suspended boolean)
language sql stable security definer set search_path = public as $$
  select public.study_year(auth.uid()), public.mentor_listed(auth.uid()), public.mentee_eligible(auth.uid()),
         exists (select 1 from public.mentor_suspensions s where s.user_id = auth.uid())
$$;
revoke execute on function public.mentorship_status() from public, anon;
grant execute on function public.mentorship_status() to authenticated;

-- Super-admin: say which year a student is in now (null = go back to what the email says).
-- Stored as a joining year, so the student still moves up every August.
create or replace function public.set_study_year(p_user uuid, p_year integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if p_year is not null and p_year not between 1 and 5 then raise exception 'Year must be between 1 and 5.'; end if;
  update public.profiles set study_batch = case when p_year is null then null else public.academic_start_year() - p_year + 1 end
  where id = p_user and status = 'verified' and person_type = 'student';
  if not found then raise exception 'Only an ID-verified student can be given a year.'; end if;
  perform public.log_audit('mentor.study_year', 'profile', p_user::text, jsonb_build_object('year', p_year));
  perform public.mentor_tidy();
end $$;
revoke execute on function public.set_study_year(uuid, integer) from public, anon;
grant execute on function public.set_study_year(uuid, integer) to authenticated;

-- For the People page.
create or replace function public.study_years(p_ids uuid[]) returns table (id uuid, study_year integer, corrected boolean)
language sql stable security definer set search_path = public as $$
  select p.id, public.study_year(p.id), p.study_batch is not null
  from public.profiles p where public.is_super_admin() and p.id = any (p_ids)
$$;
revoke execute on function public.study_years(uuid[]) from public, anon;
grant execute on function public.study_years(uuid[]) to authenticated;

-- ============================================================
-- 2. Tables: new statuses and the rules on mentor profiles
-- ============================================================
alter table public.mentor_requests drop constraint if exists mentor_requests_status_check;
alter table public.mentor_requests add constraint mentor_requests_status_check
  check (status in ('pending', 'accepted', 'declined', 'cancelled', 'closed', 'expired'));
alter table public.mentor_requests add column if not exists closed_reason text;
alter table public.mentor_sessions drop constraint if exists mentor_sessions_status_check;
alter table public.mentor_sessions add constraint mentor_sessions_status_check
  check (status in ('proposed', 'scheduled', 'done', 'cancelled'));

drop policy if exists "Read mentors" on public.mentor_profiles;
create policy "Read mentors" on public.mentor_profiles for select to authenticated
  using (public.is_verified() and (user_id = auth.uid() or public.is_admin() or (active and public.mentor_listed(user_id))));
drop policy if exists "Create own mentor profile" on public.mentor_profiles;
create policy "Create own mentor profile" on public.mentor_profiles for insert to authenticated
  with check (user_id = auth.uid() and public.mentor_listed(auth.uid()));
drop policy if exists "Edit own mentor profile" on public.mentor_profiles;
create policy "Edit own mentor profile" on public.mentor_profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.mentor_listed(auth.uid()));

-- ============================================================
-- 3. Ending a request
-- ============================================================
-- Internal: finish one open request, cancel its upcoming sessions and reminders, and tell the people concerned
-- (everyone on it except p_by, who did it).
create or replace function public._mentor_end(p_request uuid, p_status text, p_reason text, p_by uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mentor_requests;
begin
  update public.mentor_requests set status = p_status, closed_reason = p_reason
  where id = p_request and status in ('pending', 'accepted') returning * into r;
  if r.id is null then return; end if;
  delete from public.reminders where kind = 'mentor_session' and sent_at is null and ref_id in
    (select id from public.mentor_sessions where request_id = r.id and status in ('proposed', 'scheduled') and scheduled_at > now());
  update public.mentor_sessions set status = 'cancelled'
  where request_id = r.id and (status = 'proposed' or (status = 'scheduled' and scheduled_at > now()));
  insert into public.notifications (user_id, kind, title, body, url, urgency)
  select u.id, 'mentor', 'Mentorship ended: ' || r.topic, p_reason, '/dashboard/mentors?tab=requests', 2
  from auth.users u where u.id in (r.mentor_id, r.mentee_id) and u.id is distinct from p_by;
end $$;
revoke execute on function public._mentor_end(uuid, text, text, uuid) from public, anon, authenticated;

-- Applies the time-based rules: unanswered requests expire after 7 days, unconfirmed times lapse, and requests
-- close when either person is no longer in an eligible year (every 1 August) or the mentor is suspended.
-- It only enforces the rules, so any signed-in person may trigger it; the mentorship page does.
create or replace function public.mentor_tidy() returns void
language plpgsql security definer set search_path = public as $$
declare r public.mentor_requests;
begin
  for r in select * from public.mentor_requests where status in ('pending', 'accepted') for update skip locked loop
    if not public.mentor_listed(r.mentor_id) then
      perform public._mentor_end(r.id, 'closed', 'The mentor is no longer mentoring.');
    elsif not public.mentee_eligible(r.mentee_id) then
      perform public._mentor_end(r.id, 'closed', 'Mentoring is for first to third year students.');
    elsif r.status = 'pending' and r.created_at < now() - interval '7 days' then
      perform public._mentor_end(r.id, 'expired', 'No answer within 7 days. You can ask another mentor.');
    end if;
  end loop;
  update public.mentor_sessions set status = 'cancelled' where status = 'proposed' and scheduled_at <= now();
end $$;
revoke execute on function public.mentor_tidy() from public, anon;
grant execute on function public.mentor_tidy() to authenticated;

-- The student withdraws a request, or either side ends an accepted mentorship.
create or replace function public.end_mentor_request(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mentor_requests;
begin
  select * into r from public.mentor_requests where id = p_request for update;
  if r.id is null or auth.uid() is null or auth.uid() not in (r.mentor_id, r.mentee_id) then
    raise exception 'This is not your request.' using errcode = '42501';
  end if;
  if r.status = 'pending' and auth.uid() = r.mentee_id then
    perform public._mentor_end(r.id, 'cancelled', 'The student withdrew the request.', auth.uid());
  elsif r.status = 'accepted' then
    perform public._mentor_end(r.id, 'closed', case when auth.uid() = r.mentor_id then 'Ended by the mentor.' else 'Ended by the student.' end, auth.uid());
  else
    raise exception 'There is nothing to end here.';
  end if;
end $$;
revoke execute on function public.end_mentor_request(uuid) from public, anon;
grant execute on function public.end_mentor_request(uuid) to authenticated;

-- Removing a mentor profile ends that mentor's open requests.
create or replace function public._mentor_profile_removed() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.mentor_requests where mentor_id = old.user_id and status in ('pending', 'accepted') loop
    perform public._mentor_end(r.id, 'closed', 'The mentor is no longer mentoring.', old.user_id);
  end loop;
  return old;
end $$;
drop trigger if exists mentor_profile_removed on public.mentor_profiles;
create trigger mentor_profile_removed after delete on public.mentor_profiles
  for each row execute function public._mentor_profile_removed();

-- Blocking someone ends any mentorship between the two. The wording does not reveal the block.
create or replace function public._mentor_blocked() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.mentor_requests where status in ('pending', 'accepted')
             and ((mentor_id = new.blocker and mentee_id = new.blocked) or (mentor_id = new.blocked and mentee_id = new.blocker)) loop
    perform public._mentor_end(r.id, 'closed', 'This mentorship was ended.', new.blocker);
  end loop;
  return new;
end $$;
drop trigger if exists mentor_blocked on public.blocks;
create trigger mentor_blocked after insert on public.blocks
  for each row execute function public._mentor_blocked();

-- ============================================================
-- 4. Asking, answering and sessions
-- ============================================================
create or replace function public.request_mentor(p_mentor uuid, p_topic text, p_message text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_verified() then raise exception 'Verify your student ID first.' using errcode = '42501'; end if;
  if p_mentor = auth.uid() then raise exception 'You cannot mentor yourself.'; end if;
  if not public.mentee_eligible(auth.uid()) then raise exception 'Mentoring is for first to third year students.' using errcode = '42501'; end if;
  perform public.mentor_tidy();
  if not public.mentor_listed(p_mentor) or not exists (select 1 from public.mentor_profiles where user_id = p_mentor and active) then
    raise exception 'This mentor is not taking requests.';
  end if;
  if public.is_blocked_pair(p_mentor, auth.uid()) then raise exception 'You cannot contact this mentor.' using errcode = '42501'; end if;
  if (select count(*) from public.mentor_requests where mentor_id = p_mentor and status = 'accepted') >= 3 then
    raise exception 'This mentor already has 3 students. Try another mentor.';
  end if;
  perform pg_advisory_xact_lock(hashtext('mentee:' || auth.uid()::text));
  if exists (select 1 from public.mentor_requests where mentor_id = p_mentor and mentee_id = auth.uid() and status in ('pending', 'accepted')) then
    raise exception 'You already have an open request with this mentor.';
  end if;
  if (select count(*) from public.mentor_requests where mentee_id = auth.uid() and status in ('pending', 'accepted')) >= 2 then
    raise exception 'You can have 2 open requests at a time. End or withdraw one first.';
  end if;
  insert into public.mentor_requests (mentor_id, mentee_id, topic, message)
  values (p_mentor, auth.uid(), left(trim(p_topic), 140), left(trim(coalesce(p_message, '')), 500));
  insert into public.notifications (user_id, kind, title, body, url, urgency)
  values (p_mentor, 'mentor', 'New mentorship request', left(p_topic, 140), '/dashboard/mentors?tab=requests', 2);
end $$;
grant execute on function public.request_mentor(uuid, text, text) to authenticated;

create or replace function public.respond_mentor(p_request uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mentor_requests;
begin
  select * into r from public.mentor_requests where id = p_request;
  if r.mentor_id is distinct from auth.uid() then raise exception 'Only the mentor can answer this.' using errcode = '42501'; end if;
  -- one answer at a time per mentor, so the limit of 3 holds
  perform pg_advisory_xact_lock(hashtext('mentor:' || r.mentor_id::text));
  select * into r from public.mentor_requests where id = p_request for update;
  if r.status <> 'pending' or r.created_at < now() - interval '7 days' then raise exception 'This request is no longer open.'; end if;
  if p_accept then
    if not public.mentor_listed(r.mentor_id) then raise exception 'Only fourth-year students can mentor.' using errcode = '42501'; end if;
    if not public.mentee_eligible(r.mentee_id) or public.is_blocked_pair(r.mentor_id, r.mentee_id) then
      raise exception 'You cannot accept this request.' using errcode = '42501';
    end if;
    if (select count(*) from public.mentor_requests where mentor_id = r.mentor_id and status = 'accepted') >= 3 then
      raise exception 'You already have 3 students. End one before accepting another.';
    end if;
  end if;
  update public.mentor_requests set status = case when p_accept then 'accepted' else 'declined' end where id = p_request;
  insert into public.notifications (user_id, kind, title, body, url, urgency)
  values (r.mentee_id, 'mentor', case when p_accept then 'Your mentor said yes' else 'Mentor request declined' end,
          case when p_accept then 'They will suggest a time soon.' else 'Try another mentor in the same domain.' end, '/dashboard/mentors?tab=requests', 2);
end $$;
grant execute on function public.respond_mentor(uuid, boolean) to authenticated;

-- The mentor proposes a time; it becomes a session when the student confirms it.
create or replace function public.schedule_session(p_request uuid, p_at timestamptz, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mentor_requests; sid uuid;
begin
  select * into r from public.mentor_requests where id = p_request for update;
  if r.mentor_id is distinct from auth.uid() or r.status <> 'accepted' then raise exception 'Only the mentor can schedule an accepted request.' using errcode = '42501'; end if;
  if not public.mentor_listed(r.mentor_id) or not public.mentee_eligible(r.mentee_id) or public.is_blocked_pair(r.mentor_id, r.mentee_id) then
    raise exception 'This mentorship can no longer be scheduled.' using errcode = '42501';
  end if;
  if p_at is null or p_at <= now() then raise exception 'Pick a time in the future.'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Add a meeting link or a place on campus.'; end if;
  update public.mentor_sessions set status = 'cancelled' where request_id = r.id and status = 'proposed' and scheduled_at <= now();
  if exists (select 1 from public.mentor_sessions where request_id = r.id and (status = 'proposed' or (status = 'scheduled' and scheduled_at > now()))) then
    raise exception 'There is already an upcoming time. Cancel it first.';
  end if;
  insert into public.mentor_sessions (request_id, scheduled_at, note, status)
  values (r.id, p_at, left(trim(p_note), 300), 'proposed') returning id into sid;
  insert into public.notifications (user_id, kind, title, body, url, urgency, ref_id)
  values (r.mentee_id, 'mentor', 'Please confirm a session time', to_char(p_at at time zone 'Asia/Kolkata', 'FMDay DD Mon, HH12:MI AM') || ' · ' || trim(p_note), '/dashboard/mentors?tab=requests', 1, sid);
end $$;
grant execute on function public.schedule_session(uuid, timestamptz, text) to authenticated;

create or replace function public.confirm_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.mentor_sessions; r public.mentor_requests; u uuid; t timestamptz;
begin
  select * into s from public.mentor_sessions where id = p_session for update;
  select * into r from public.mentor_requests where id = s.request_id;
  if r.mentee_id is distinct from auth.uid() then raise exception 'Only the student can confirm a time.' using errcode = '42501'; end if;
  if r.status <> 'accepted' or s.status <> 'proposed' or s.scheduled_at <= now() then raise exception 'This time can no longer be confirmed.'; end if;
  if not public.mentor_listed(r.mentor_id) or not public.mentee_eligible(r.mentee_id) or public.is_blocked_pair(r.mentor_id, r.mentee_id) then
    raise exception 'This mentorship has ended.' using errcode = '42501';
  end if;
  update public.mentor_sessions set status = 'scheduled' where id = s.id;
  foreach u in array array[r.mentor_id, r.mentee_id] loop
    foreach t in array array[s.scheduled_at - interval '1 day', s.scheduled_at - interval '1 hour'] loop
      if t > now() then
        insert into public.reminders (user_id, kind, ref_id, title, url, remind_at)
        values (u, 'mentor_session', s.id, 'Mentoring session: ' || r.topic, '/dashboard/mentors?tab=requests', t) on conflict do nothing;
      end if;
    end loop;
  end loop;
  insert into public.notifications (user_id, kind, title, body, url, urgency, ref_id)
  values (r.mentor_id, 'mentor', 'Session confirmed', r.topic, '/dashboard/mentors?tab=requests', 2, s.id);
end $$;
revoke execute on function public.confirm_session(uuid) from public, anon;
grant execute on function public.confirm_session(uuid) to authenticated;

-- Either side cancels a proposed or upcoming time (for the student, this also means "that time does not work").
create or replace function public.cancel_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.mentor_sessions; r public.mentor_requests;
begin
  select * into s from public.mentor_sessions where id = p_session for update;
  select * into r from public.mentor_requests where id = s.request_id;
  if r.id is null or auth.uid() is null or auth.uid() not in (r.mentor_id, r.mentee_id) then
    raise exception 'This is not your session.' using errcode = '42501';
  end if;
  if not (s.status = 'proposed' or (s.status = 'scheduled' and s.scheduled_at > now())) then raise exception 'Only an upcoming session can be cancelled.'; end if;
  update public.mentor_sessions set status = 'cancelled' where id = s.id;
  delete from public.reminders where kind = 'mentor_session' and ref_id = s.id and sent_at is null;
  insert into public.notifications (user_id, kind, title, body, url, urgency, ref_id)
  values (case when auth.uid() = r.mentor_id then r.mentee_id else r.mentor_id end, 'mentor', 'Session time cancelled', r.topic, '/dashboard/mentors?tab=requests', 1, s.id);
end $$;
revoke execute on function public.cancel_session(uuid) from public, anon;
grant execute on function public.cancel_session(uuid) to authenticated;

-- Recording that a confirmed session happened stays possible after the mentorship has ended.
create or replace function public.complete_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.mentor_sessions; r public.mentor_requests;
begin
  select * into s from public.mentor_sessions where id = p_session for update;
  select * into r from public.mentor_requests where id = s.request_id;
  if r.mentor_id is distinct from auth.uid() then raise exception 'Only the mentor can do this.' using errcode = '42501'; end if;
  if s.status <> 'scheduled' or s.scheduled_at > now() then raise exception 'You can mark a confirmed session done after it has started.'; end if;
  update public.mentor_sessions set status = 'done' where id = p_session;
  insert into public.notifications (user_id, kind, title, body, url, urgency, ref_id)
  values (r.mentee_id, 'mentor', 'How was your session?', 'Leave a rating and a line of feedback for your mentor.', '/dashboard/mentors?tab=requests', 2, p_session);
end $$;
grant execute on function public.complete_session(uuid) to authenticated;

-- ============================================================
-- 5. Directory
-- ============================================================
-- Same shape as in dashboard-4 (so that file can still be re-run); only eligible mentors, with the current year.
create or replace function public.mentor_directory() returns table (user_id uuid, full_name text, branch text, year smallint, domains text[], bio text, availability text, avg_rating numeric, sessions integer)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.full_name, p.branch, public.study_year(m.user_id)::smallint, m.domains, m.bio, m.availability,
         (select round(avg(s.rating)::numeric, 1) from public.mentor_sessions s join public.mentor_requests r on r.id = s.request_id where r.mentor_id = m.user_id and s.rating is not null),
         (select count(*)::integer from public.mentor_sessions s join public.mentor_requests r on r.id = s.request_id where r.mentor_id = m.user_id and s.status = 'done')
  from public.mentor_profiles m join public.profiles p on p.id = m.user_id
  where public.is_verified() and m.active and public.mentor_listed(m.user_id) and not public.is_blocked_pair(m.user_id, auth.uid())
$$;
grant execute on function public.mentor_directory() to authenticated;

create or replace function public.mentor_slots() returns table (user_id uuid, free integer)
language sql stable security definer set search_path = public as $$
  select m.user_id, greatest(0, 3 - (select count(*)::integer from public.mentor_requests r where r.mentor_id = m.user_id and r.status = 'accepted'))
  from public.mentor_profiles m where public.is_verified() and m.active and public.mentor_listed(m.user_id)
$$;
revoke execute on function public.mentor_slots() from public, anon;
grant execute on function public.mentor_slots() to authenticated;

create or replace function public.mentor_people() returns table (id uuid, full_name text, branch text, year smallint)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.branch, (case when public.study_year(p.id) <= 4 then public.study_year(p.id) end)::smallint from public.profiles p
  where p.id in (select mentor_id from public.mentor_requests where mentee_id = auth.uid()
                 union select mentee_id from public.mentor_requests where mentor_id = auth.uid())
$$;
grant execute on function public.mentor_people() to authenticated;

-- ============================================================
-- 6. Safety: suspending a mentor, and reports
-- ============================================================
create or replace function public.suspend_mentor(p_user uuid, p_suspend boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_admin() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if p_suspend then
    insert into public.mentor_suspensions (user_id, reason, suspended_by)
    values (p_user, nullif(left(trim(coalesce(p_reason, '')), 300), ''), auth.uid())
    on conflict (user_id) do update set reason = excluded.reason, suspended_by = excluded.suspended_by, created_at = now();
    for r in select id from public.mentor_requests where mentor_id = p_user and status in ('pending', 'accepted') loop
      perform public._mentor_end(r.id, 'closed', 'The mentor is no longer mentoring.', p_user);
    end loop;
    insert into public.notifications (user_id, kind, title, body, url, urgency)
    values (p_user, 'mentor', 'Your mentoring is paused by an admin', 'Contact a college admin if you think this is a mistake.', '/dashboard/mentors', 1);
  else
    delete from public.mentor_suspensions where user_id = p_user;
    if not found then return; end if;
  end if;
  perform public.log_audit(case when p_suspend then 'mentor.suspended' else 'mentor.reinstated' end, 'user', p_user::text, jsonb_build_object('reason', p_reason));
end $$;
revoke execute on function public.suspend_mentor(uuid, boolean, text) from public, anon;
grant execute on function public.suspend_mentor(uuid, boolean, text) to authenticated;

-- As in dashboard-4, plus: acting on a report about a mentor suspends their mentoring.
create or replace function public.resolve_report(p_id uuid, p_remove boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reports;
begin
  if not public.is_admin() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  select * into r from public.reports where id = p_id and status = 'open';
  if r.id is null then raise exception 'That report is already resolved.'; end if;
  if p_remove then
    if r.kind = 'connect_post' then update public.connect_posts set status = 'removed' where id = r.ref_id;
    elsif r.kind = 'listing' then update public.listings set status = 'removed' where id = r.ref_id;
    elsif r.kind = 'note' then update public.notes set status = 'rejected', review_note = 'Removed after a report' where id = r.ref_id;
    elsif r.kind = 'message' then delete from public.messages where id = r.ref_id;
    elsif r.kind = 'user' then
      if not exists (select 1 from public.mentor_profiles where user_id = r.ref_id) then
        raise exception 'This person is not a mentor. Mark the report reviewed instead.';
      end if;
      perform public.suspend_mentor(r.ref_id, true, coalesce(nullif(trim(coalesce(p_note, '')), ''), r.reason));
    end if;
  end if;
  update public.reports set status = case when p_remove then 'actioned' else 'dismissed' end, resolution = nullif(trim(coalesce(p_note, '')), ''),
    resolved_by = auth.uid(), resolved_at = now() where id = p_id;
  perform public.log_audit(case when p_remove then 'report.actioned' else 'report.dismissed' end, r.kind, r.ref_id::text, jsonb_build_object('reason', r.reason, 'note', p_note));
end $$;
grant execute on function public.resolve_report(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';

import fs from "node:fs";
import { run } from "../../scripts/rls-harness.mjs";

const SHA = (c) => c.repeat(64);

await run("Stage 13: cultural events (drafts, publishing, posters, RSVPs, reminders, alerts)", async (t) => {
  // After a signed-in step the session claims linger inside the transaction; clear them before every admin statement.
  const rawAdmin = t.admin.bind(t);
  t.admin = async (sql, params = []) => {
    await rawAdmin("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
    return rawAdmin(sql, params);
  };

  const adm = await t.user("admin", { role: "admin" });
  const clubA = await t.user("clubA", {});
  const clubB = await t.user("clubB", {});
  const s1 = await t.user("s1", {});
  const s2 = await t.user("s2", {});
  const fan = await t.user("fan", {});
  const raw = await t.user("raw", { status: "unverified" });
  await t.admin("insert into public.clubs (name, slug) values ('ZZ Club A', 'zz-a'), ('ZZ Club B', 'zz-b')");
  const [a, b] = (await t.admin("select id from public.clubs where slug in ('zz-a', 'zz-b') order by slug")).rows.map((r) => r.id);
  await t.admin("insert into public.club_admins (club_id, user_id) values ($1, $2), ($3, $4)", [a, clubA, b, clubB]);
  await t.admin("insert into public.club_follows (user_id, club_id) values ($1, $2)", [fan, a]);

  const mk = (u, { club = a, status = "draft", title = "Open mic", days = 5, by = u } = {}) =>
    t.as(u, `insert into public.events (title, club_id, status, starts_at, venue, created_by) values ($1, $2, $3, now() + make_interval(days => $4), 'Auditorium', $5) returning id`,
      [title, club, status, days, by]);
  const ids = async (u) => (await t.as(u, "select id from public.events")).rows.map((r) => r.id);
  const rsvp = (u, e, s = "going") => t.as(u, "insert into public.event_rsvps (event_id, user_id, status) values ($1, $2, $3) on conflict (event_id, user_id) do update set status = excluded.status", [e, u, s]);
  const reminders = async (e, u) => (await t.admin("select remind_at from public.reminders where kind = 'event' and ref_id = $1 and user_id = $2 and sent_at is null", [e, u])).rows;
  const told = async (u, like) => (await t.admin("select 1 from public.notifications where user_id = $1 and kind = 'event' and title like $2", [u, like])).rows.length;

  // ---------- events posted before this file stay visible ----------
  const old = (await t.admin("insert into public.events (title, starts_at) values ('Old event', now() + interval '4 days') returning id, status")).rows[0];
  t.check("an old event is published by default", old.status === "published");
  t.check("students still see it", (await ids(s1)).includes(old.id));
  t.check("the older add form (no status, no creator) still works", !(await t.as(clubA, "insert into public.events (title, club_id, starts_at) values ('Old form', $1, now() + interval '2 days')", [a])).error);

  // ---------- who can post ----------
  const d = await mk(clubA);
  t.check("a club admin can create a draft for their club", !d.error, d.error);
  const e = d.rows[0].id;
  t.check("a club admin cannot post for another club", !!(await mk(clubA, { club: b })).error);
  t.check("a club admin cannot post without a club", !!(await mk(clubA, { club: null })).error);
  t.check("a club admin cannot post in someone else's name", !!(await mk(clubA, { by: clubB })).error);
  t.check("a student cannot post", !!(await mk(s1)).error);
  t.check("an admin can post a college event", !(await mk(adm, { club: null })).error);
  t.check("a club admin cannot move an event to another club", !!(await t.as(clubA, "update public.events set club_id = $2 where id = $1", [e, b])).error);

  // ---------- drafts are private ----------
  t.check("students do not see drafts", !(await ids(s1)).includes(e));
  t.check("another club's admin does not", !(await ids(clubB)).includes(e));
  t.check("the club admin and the central admin do", (await ids(clubA)).includes(e) && (await ids(adm)).includes(e));
  t.check("no counts are given for a hidden draft", (await t.as(s1, "select 1 from public.event_counts() where event_id = $1", [e])).rows.length === 0);
  t.check("nobody can RSVP to a draft", !!(await rsvp(s1, e)).error);
  t.check("followers are not told about a draft", (await told(fan, "%")) === 1);   // 1 = the "Old form" event above
  t.check("a draft may have no date", !(await t.as(clubA, "insert into public.events (title, club_id, status, created_by) values ('Undated', $1, 'draft', $2)", [a, clubA])).error);
  t.check("a published one must have a date", !!(await t.as(clubA, "update public.events set status = 'published', starts_at = null where id = $1", [e])).error);
  t.check("it cannot end before it starts", !!(await t.as(clubA, "update public.events set status = 'published', ends_at = starts_at - interval '1 hour' where id = $1", [e])).error);

  // ---------- posters and AI readings ----------
  const path = `${clubA}/11111111-1111-1111-1111-111111111111.jpg`;
  const upload = (u, name) => t.as(u, "insert into storage.objects (bucket_id, name) values ('event-files', $1)", [name]);
  const attach = (u, ev, p, c) => t.as(u, `insert into public.event_documents (event_id, storage_path, original_filename, mime_type, size_bytes, sha256, uploaded_by) values ($1, $2, 'p.jpg', 'image/jpeg', 10, $3, $4) returning id`, [ev, p, SHA(c), u]);
  const files = async (u) => (await t.as(u, "select 1 from storage.objects where bucket_id = 'event-files'")).rows.length;
  t.check("an organiser can upload into their own folder", !(await upload(clubA, path)).error);
  t.check("not into someone else's", !!(await upload(clubA, `${clubB}/x.jpg`)).error);
  t.check("a student cannot upload", !!(await upload(s1, `${s1}/x.jpg`)).error);
  const doc = await attach(clubA, e, path, "a");
  t.check("the poster can be attached", !doc.error, doc.error);
  t.check("another club cannot attach to it", !!(await attach(clubB, e, `${clubB}/y.jpg`, "b")).error);
  const own = (await mk(clubB, { club: b })).rows[0].id;
  t.check("nobody can attach somebody else's file", !!(await attach(clubB, own, `${clubA}/z.jpg`, "c")).error);
  const ex = await t.as(clubA, "insert into public.event_extractions (document_id) values ($1) returning id", [doc.rows[0].id]);
  t.check("the organiser can start a reading", !ex.error, ex.error);
  t.check("students cannot see readings", (await t.as(s1, "select 1 from public.event_extractions")).rows.length === 0);
  t.check("students cannot see a draft's poster", (await files(s1)) === 0 && (await t.as(s1, "select 1 from public.event_documents")).rows.length === 0);
  t.check("duplicates are found for managers only", (await t.as(clubA, "select * from public.event_find_duplicates($1)", [SHA("a")])).rows.length === 1 && (await t.as(clubB, "select * from public.event_find_duplicates($1)", [SHA("a")])).rows.length === 0);

  // ---------- publishing ----------
  const pub = await t.as(clubA, "update public.events set status = 'published' where id = $1 returning published_at", [e]);
  t.check("the organiser publishes with no approval", !pub.error && pub.rows[0]?.published_at, pub.error);
  t.check("students now see it", (await ids(s1)).includes(e));
  t.check("and its poster", (await files(s1)) === 1);
  t.check("unverified users see nothing", (await ids(raw)).length === 0 && (await files(raw)) === 0);
  t.check("followers are told once", (await told(fan, "New event: Open mic")) === 1);
  t.check("other students are not", (await told(s1, "%")) === 0);
  t.check("students cannot edit it", (await t.as(s1, "update public.events set title = 'Hacked' where id = $1 returning id", [e])).rows.length === 0);

  // ---------- RSVPs ----------
  t.check("students can say going or interested", !(await rsvp(s1, e)).error && !(await rsvp(s2, e, "interested")).error);
  t.check("and change their answer", !(await rsvp(s2, e, "going")).error);
  t.check("nobody can answer for someone else", !!(await t.as(s1, "insert into public.event_rsvps (event_id, user_id, status) values ($1, $2, 'going')", [e, fan])).error);
  t.check("students see only their own answer", (await t.as(s1, "select 1 from public.event_rsvps")).rows.length === 1);
  t.check("organisers see no names", (await t.as(clubA, "select 1 from public.event_rsvps")).rows.length === 0);
  const c = (await t.as(clubA, "select interested, going from public.event_counts() where event_id = $1", [e])).rows[0];
  t.check("organisers see the counts", c?.going === 2 && c?.interested === 0, JSON.stringify(c));
  const past = (await t.admin("insert into public.events (title, starts_at) values ('Long gone', now() - interval '2 days') returning id")).rows[0].id;
  t.check("no RSVP once it is over", !!(await rsvp(s1, past)).error);
  const live = (await t.admin("insert into public.events (title, starts_at) values ('On now', now() - interval '1 hour') returning id")).rows[0].id;
  t.check("RSVP works while it is running", !(await rsvp(s1, live)).error);

  // ---------- reminders and changes ----------
  await t.as(s1, "insert into public.reminders (user_id, kind, ref_id, title, url, remind_at) select $1, 'event', id, title, '/dashboard/events', starts_at - interval '1 hour' from public.events where id = $2", [s1, e]);
  await t.as(clubA, "update public.events set description = 'Bring a song' where id = $1", [e]);
  t.check("an ordinary edit alerts nobody", (await told(s1, "Changed:%")) === 0);
  await t.as(clubA, "update public.events set starts_at = starts_at + interval '2 days' where id = $1", [e]);
  const moved = await t.admin("select count(*)::int n, bool_and(r.remind_at = ev.starts_at - interval '1 hour') ok from public.reminders r join public.events ev on ev.id = r.ref_id where r.ref_id = $1", [e]);
  t.check("a new start time moves the reminder", moved.rows[0].ok && moved.rows[0].n === 1, JSON.stringify(moved.rows[0]));
  t.check("and tells those who answered", (await told(s1, "Changed:%")) === 1 && (await told(s2, "Changed:%")) === 1);
  t.check("but not followers who did not", (await told(fan, "Changed:%")) === 0);

  await t.as(clubA, "update public.events set status = 'draft' where id = $1", [e]);
  t.check("unpublishing hides it and drops reminders", !(await ids(s1)).includes(e) && (await reminders(e, s1)).length === 0);
  await t.as(clubA, "update public.events set venue = 'Open air theatre' where id = $1", [e]);
  await t.as(clubA, "update public.events set status = 'published' where id = $1", [e]);
  t.check("publishing again with a new venue tells those who answered", (await told(s1, "Changed:%")) === 2);
  t.check("without telling followers again", (await told(fan, "New event: Open mic")) === 1);
  await t.as(clubA, "update public.events set published_at = null where id = $1", [e]);
  t.check("the first-published time cannot be reset", !!(await t.admin("select published_at from public.events where id = $1", [e])).rows[0].published_at);

  await t.as(clubA, "update public.events set status = 'cancelled' where id = $1", [e]);
  t.check("cancelling tells those who answered", (await told(s1, "Cancelled:%")) === 1);
  t.check("students see it as cancelled", (await ids(s1)).includes(e));
  t.check("nobody can RSVP to a cancelled one", !!(await rsvp(fan, e)).error);
  t.check("an answer can still be withdrawn", (await t.as(s1, "delete from public.event_rsvps where event_id = $1 returning event_id", [e])).rows.length === 1);

  await t.as(s2, "insert into public.reminders (user_id, kind, ref_id, title, remind_at) values ($1, 'event', $2, 'x', now() + interval '1 day')", [s2, e]);
  await t.as(clubA, "delete from public.events where id = $1", [e]);
  t.check("deleting removes the reminders", (await t.admin("select 1 from public.reminders where ref_id = $1", [e])).rows.length === 0);

  // ---------- safe to run again ----------
  const sql = fs.readFileSync(new URL("../dashboard-13-events.sql", import.meta.url), "utf8");
  let again = null;
  try { await t.admin(sql); } catch (er) { again = er.message; }
  t.check("the file can be run again", !again, again);
});

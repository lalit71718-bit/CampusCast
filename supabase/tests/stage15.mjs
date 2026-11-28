// Free mentorship rules (dashboard-15). Offline:
//   node supabase/tests/runtest.mjs supabase/tests/stage15.mjs dashboard-15-mentorship.sql
import fs from "node:fs";
import { run } from "../../scripts/rls-harness.mjs";

await run("Stage 15: free mentorship", async (t) => {
  const start = (await t.admin("select public.academic_start_year() y")).rows[0].y;
  let roll = 100;
  // A student whose college email puts them in the given year of study today.
  const student = async (label, year, fields = {}, level = "ug") => {
    const id = await t.user(label, fields);
    const yy = String((start - year + 1) % 100).padStart(2, "0");
    await t.admin("update auth.users set email = $2 where id = $1", [id, `${yy}${level}1byai${++roll}@bmsit.in`]);
    return id;
  };
  const ok = async (label, who, sql, params) => { const r = await t.as(who, sql, params); t.check(label, !r.error, r.error); return r; };
  const no = async (label, who, sql, params) => { const r = await t.as(who, sql, params); t.check(label, !!r.error || r.rowCount === 0, JSON.stringify(r.rows)); };
  const one = async (sql, params) => (await t.admin(sql, params)).rows[0];
  const status = async (who) => (await t.as(who, "select * from public.mentorship_status()")).rows[0];
  const become = "insert into public.mentor_profiles (user_id, domains) values ($1, '{dsa}')";
  const ask = "select public.request_mentor($1, $2, '')";
  const reqId = async (mentee, mentor) => (await one("select id from public.mentor_requests where mentee_id = $1 and mentor_id = $2 order by (status in ('pending','accepted')) desc limit 1", [mentee, mentor])).id;
  const reqStatus = async (id) => (await one("select status from public.mentor_requests where id = $1", [id])).status;

  // --- the academic year turns on 1 August, Indian time ---
  const at = async (ts) => (await one("select public.academic_start_year($1::timestamptz) y", [ts])).y;
  t.check("31 July belongs to the old year", (await at("2027-07-31 23:00+05:30")) === 2026);
  t.check("1 August starts the new year", (await at("2027-08-01 00:30+05:30")) === 2027);

  const superA = await t.user("super", { role: "super_admin" });
  const admin = await t.user("admin", { role: "admin" });
  const y1 = await student("one", 1);
  const y2 = await student("two", 2, { year: 4 }); // typed "year 4" at verification: must not count
  const y3 = await student("three", 3);
  const m1 = await student("mentor1", 4, { year: 1 }); // typed year is ignored here too
  const m2 = await student("mentor2", 4);
  const m3 = await student("mentor3", 4);
  const grad = await student("grad", 5);
  const pg = await student("pg", 4, {}, "pg");
  const odd = await t.user("odd", { year: 4 });
  const fac = await student("faculty", 4);
  await t.admin("update public.profiles set person_type = 'faculty' where id = $1", [fac]);
  const unver = await student("unverified", 4, { status: "pending" });
  const other = await student("other", 4);
  await t.admin("update auth.users set email = '23ug1byai999@other.edu' where id = $1", [other]);

  // --- who may mentor ---
  for (const [name, who] of [["first", y1], ["second", y2], ["third", y3], ["graduated", grad], ["postgraduate", pg], ["unreadable email", odd], ["faculty", fac], ["unverified", unver], ["other college", other]]) {
    await no(`${name}: cannot become a mentor`, who, become, [who]);
  }
  for (const [i, m] of [m1, m2, m3].entries()) await ok(`fourth year ${i + 1} can become a mentor`, m, become, [m]);
  t.check("status: fourth year mentors, does not ask", JSON.stringify(await status(m1)) === JSON.stringify({ study_year: 4, can_mentor: true, can_ask: false, suspended: false }));
  t.check("status: second year asks, whatever was typed", (await status(y2)).study_year === 2 && (await status(y2)).can_ask === true);
  const dir = (await t.as(y1, "select * from public.mentor_directory()")).rows;
  t.check("directory lists the three mentors with computed year", dir.length === 3 && dir.every((m) => m.year === 4));

  // --- who may ask ---
  await no("fourth year cannot ask for mentoring", m2, ask, [m1, "Help me"]);
  await no("graduate cannot ask", grad, ask, [m1, "Help me"]);
  await no("faculty cannot ask", fac, ask, [m1, "Help me"]);
  await no("nobody can ask a non-mentor", y1, ask, [y3, "Help me"]);
  await ok("first year asks mentor 1", y1, ask, [m1, "DSA help"]);
  await no("no second open request to the same mentor", y1, ask, [m1, "Again"]);
  await ok("and mentor 2", y1, ask, [m2, "Web help"]);
  await no("a third open request is refused", y1, ask, [m3, "More help"]);
  await no("requests cannot be inserted directly", y3, "insert into public.mentor_requests (mentor_id, mentee_id, topic) values ($1, $2, 'sneaky')", [m1, y3]);

  // --- capacity of 3 ---
  const extra = [];
  for (const n of [1, 2, 3]) extra.push(await student(`extra${n}`, 2));
  await ok("second year asks", y2, ask, [m1, "Placements"]);
  await ok("third year asks", y3, ask, [m1, "Projects"]);
  await ok("another asks", extra[0], ask, [m1, "Internships"]);
  for (const [i, s] of [y1, y2, y3].entries()) await ok(`mentor accepts student ${i + 1}`, m1, "select public.respond_mentor($1, true)", [await reqId(s, m1)]);
  await no("fourth acceptance refused", m1, "select public.respond_mentor($1, true)", [await reqId(extra[0], m1)]);
  await no("new requests refused when full", extra[1], ask, [m1, "Hello"]);
  t.check("slots show full", (await t.as(y1, "select free from public.mentor_slots() where user_id = $1", [m1])).rows[0].free === 0);
  await no("only the mentor answers", y1, "select public.respond_mentor($1, true)", [await reqId(extra[0], m1)]);

  // --- sessions ---
  const r2 = await reqId(y2, m1);
  await no("a time needs a link or place", m1, "select public.schedule_session($1, now() + interval '3 days', '  ')", [r2]);
  await no("a time must be in the future", m1, "select public.schedule_session($1, now() - interval '1 hour', 'Library')", [r2]);
  await ok("mentor proposes a time", m1, "select public.schedule_session($1, now() + interval '3 days', 'Library')", [r2]);
  const sess = async (req) => (await one("select id, status from public.mentor_sessions where request_id = $1 order by (status <> 'cancelled') desc, (status <> 'done') desc limit 1", [req]));
  const s1 = (await sess(r2)).id;
  t.check("it is only proposed, with no reminders yet", (await sess(r2)).status === "proposed" && (await one("select count(*)::int c from public.reminders where ref_id = $1", [s1])).c === 0);
  await no("mentor cannot confirm for the student", m1, "select public.confirm_session($1)", [s1]);
  await no("outsider cannot cancel it", y3, "select public.cancel_session($1)", [s1]);
  await ok("student confirms", y2, "select public.confirm_session($1)", [s1]);
  t.check("both get two reminders", (await one("select count(*)::int c from public.reminders where ref_id = $1", [s1])).c === 4);
  await no("no second upcoming time", m1, "select public.schedule_session($1, now() + interval '4 days', 'Library')", [r2]);
  await no("cannot mark done before it starts", m1, "select public.complete_session($1)", [s1]);
  await ok("student cancels", y2, "select public.cancel_session($1)", [s1]);
  t.check("reminders removed", (await one("select count(*)::int c from public.reminders where ref_id = $1", [s1])).c === 0);
  await ok("mentor proposes again", m1, "select public.schedule_session($1, now() + interval '5 days', 'Meet link')", [r2]);
  const s2 = (await sess(r2)).id;
  await ok("student confirms the new time", y2, "select public.confirm_session($1)", [s2]);
  await t.admin("update public.mentor_sessions set scheduled_at = now() - interval '1 hour' where id = $1", [s2]);
  await ok("mentor marks it done", m1, "select public.complete_session($1)", [s2]);
  await ok("student rates it", y2, "select public.rate_session($1, 5, 'great')", [s2]);
  await ok("a second session can follow", m1, "select public.schedule_session($1, now() + interval '9 days', 'Lab 2')", [r2]);
  const s3 = (await one("select id from public.mentor_sessions where request_id = $1 and status = 'proposed'", [r2])).id;
  await t.admin("update public.mentor_sessions set scheduled_at = now() - interval '1 minute' where id = $1", [s3]);
  await no("a lapsed time cannot be confirmed", y2, "select public.confirm_session($1)", [s3]);
  await ok("tidy runs", y2, "select public.mentor_tidy()");
  t.check("lapsed proposal cancelled", (await one("select status from public.mentor_sessions where id = $1", [s3])).status === "cancelled");

  // --- ending, expiry ---
  await no("outsider cannot end a mentorship", y3, "select public.end_mentor_request($1)", [r2]);
  await ok("student ends it", y2, "select public.end_mentor_request($1)", [r2]);
  t.check("it is closed", (await reqStatus(r2)) === "closed");
  await ok("and may ask the same mentor again", y2, ask, [m1, "Round two"]);
  const px = await reqId(extra[0], m1);
  await no("mentor cannot withdraw a pending request", m1, "select public.end_mentor_request($1)", [px]);
  await t.admin("update public.mentor_requests set created_at = now() - interval '8 days' where id = $1", [px]);
  await no("an old request cannot be accepted", m1, "select public.respond_mentor($1, true)", [px]);
  await ok("tidy again", y1, "select public.mentor_tidy()");
  t.check("unanswered request expired", (await reqStatus(px)) === "expired");
  await ok("student withdraws a pending one", y1, "select public.end_mentor_request($1)", [await reqId(y1, m2)]);

  // --- blocks ---
  const r3 = await reqId(y3, m1);
  await ok("time proposed", m1, "select public.schedule_session($1, now() + interval '3 days', 'Library')", [r3]);
  await ok("student blocks the mentor", y3, "insert into public.blocks (blocker, blocked) values ($1, $2)", [y3, m1]);
  t.check("block ends it and cancels the time", (await reqStatus(r3)) === "closed" && (await one("select status from public.mentor_sessions where request_id = $1", [r3])).status === "cancelled");
  await no("blocked pair cannot ask again", y3, ask, [m1, "Hello"]);

  // --- reports and suspension ---
  await ok("report a mentor", y1, "insert into public.reports (reporter, kind, ref_id, reason) values ($1, 'user', $2, 'rude')", [y1, m1]);
  await no("students cannot suspend", y1, "select public.suspend_mentor($1, true, 'x')", [m2]);
  await no("students cannot write suspensions", m2, "insert into public.mentor_suspensions (user_id) values ($1)", [m3]);
  const rep = (await one("select id from public.reports where ref_id = $1", [m1])).id;
  await ok("admin acts on the report", admin, "select public.resolve_report($1, true, 'confirmed')", [rep]);
  t.check("mentor suspended and requests closed", (await status(m1)).suspended === true && (await one("select count(*)::int c from public.mentor_requests where mentor_id = $1 and status in ('pending','accepted')", [m1])).c === 0);
  t.check("suspended mentor leaves the directory", (await t.as(y1, "select 1 from public.mentor_directory() where user_id = $1", [m1])).rows.length === 0);
  await no("suspended mentor cannot edit the profile", m1, "update public.mentor_profiles set active = true where user_id = $1 returning 1", [m1]);
  await t.as(m1, "delete from public.mentor_profiles where user_id = $1", [m1]);
  await no("nor rejoin by recreating it", m1, become, [m1]);
  await no("a suspended person cannot lift it", m1, "delete from public.mentor_suspensions where user_id = $1 returning 1", [m1]);
  await ok("admin lifts the suspension", admin, "select public.suspend_mentor($1, false)", [m1]);
  await ok("mentor can sign up again", m1, become, [m1]);
  await ok("report a non-mentor", y1, "insert into public.reports (reporter, kind, ref_id, reason) values ($1, 'user', $2, 'spam')", [y1, y2]);
  await no("acting on a non-mentor report is refused", admin, "select public.resolve_report($1, true)", [(await one("select id from public.reports where ref_id = $1", [y2])).id]);

  // --- removing a profile ---
  await ok("ask mentor 3", y1, ask, [m3, "Hello"]);
  const r5 = await reqId(y1, m3);
  await ok("mentor 3 removes the profile", m3, "delete from public.mentor_profiles where user_id = $1", [m3]);
  t.check("open requests close with it", (await reqStatus(r5)) === "closed");

  // --- graduation ---
  await ok("ask mentor 2", y1, ask, [m2, "Before graduation"]);
  const r6 = await reqId(y1, m2);
  await ok("accepted", m2, "select public.respond_mentor($1, true)", [r6]);
  // one year passes for mentor 2: the same as an email one batch older
  await t.admin("update auth.users set email = $2 where id = $1", [m2, `${String((start - 4) % 100).padStart(2, "0")}ug1byai501@bmsit.in`]);
  await no("graduated mentor cannot schedule", m2, "select public.schedule_session($1, now() + interval '3 days', 'Library')", [r6]);
  await no("graduate's profile is hidden", y1, "select * from public.mentor_profiles where user_id = $1", [m2]);
  await ok("tidy after graduation", y1, "select public.mentor_tidy()");
  t.check("graduation closes the mentorship", (await reqStatus(r6)) === "closed");

  // --- super-admin correction ---
  await no("students cannot set their own year", y3, "select public.set_study_year($1, 4)", [y3]);
  await no("students cannot write study_batch", y3, "update public.profiles set study_batch = 2000 where id = $1 returning 1", [y3]);
  await no("plain admins cannot either", admin, "select public.set_study_year($1, 4)", [odd]);
  await ok("super-admin corrects an unreadable email", superA, "select public.set_study_year($1, 4)", [odd]);
  await ok("corrected student can mentor", odd, become, [odd]);
  await ok("super-admin clears it", superA, "select public.set_study_year($1, null)", [odd]);
  t.check("back to the email rule", (await status(odd)).study_year === null);
  await no("faculty cannot be given a year", superA, "select public.set_study_year($1, 4)", [fac]);
  await no("the year helper is private", y1, "select public.study_year($1)", [m1]);

  // --- re-running ---
  const sql = fs.readFileSync(new URL("../dashboard-15-mentorship.sql", import.meta.url), "utf8");
  let again = "";
  try { await t.c.query(sql); } catch (e) { again = e.message; }
  t.check("dashboard-15 can be run again", !again, again);
  const four = fs.readFileSync(new URL("../dashboard-4-community.sql", import.meta.url), "utf8");
  try { await t.c.query(four); await t.c.query(sql); } catch (e) { again = e.message; }
  t.check("dashboard-4 then -15 can be run again", !again, again);
});

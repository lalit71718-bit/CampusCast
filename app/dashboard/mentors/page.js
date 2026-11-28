import Link from "next/link";
import { Star } from "lucide-react";
import { requireVerified } from "../../../lib/dash/ctx";
import { shortBranch } from "../../../lib/dash/meta";
import { AskMentor, MentorProfileForm, RemoveMentorProfile, RequestCard } from "../../../components/dashboard/MentorUI";
import { ReportBlock } from "../../../components/dashboard/Common";
import { Tabs } from "../../../components/dashboard/Bits";

export const metadata = { title: "Free mentorship" };
const TABS = [["find", "Find a mentor"], ["requests", "My requests & sessions"]];

export default async function Mentors({ searchParams }) {
  const sp = await searchParams;
  const one = (v) => (Array.isArray(v) ? v[0] : v) || "";
  const tab = TABS.some(([v]) => v === sp.tab) ? sp.tab : "find";
  const domain = one(sp.domain).trim().toLowerCase();
  const branch = one(sp.branch);
  const { supabase, user } = await requireVerified();

  // Expire old requests and close those that are no longer allowed, before anything is read.
  await supabase.rpc("mentor_tidy");
  const [{ data: status, error: statusErr }, { data: dir }, { data: slots }, { data: mineProfile }, { data: reqs }, { data: people }] = await Promise.all([
    supabase.rpc("mentorship_status"),
    supabase.rpc("mentor_directory"),
    supabase.rpc("mentor_slots"),
    supabase.from("mentor_profiles").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("mentor_requests").select("*, mentor_sessions(*)").order("created_at", { ascending: false }),
    supabase.rpc("mentor_people"),
  ]);
  // Without dashboard-15 the year rules are not in place, so nothing new can be started from here.
  const me = statusErr ? null : status?.[0];
  const who = new Map((people || []).map((p) => [p.id, p]));
  const free = new Map((slots || []).map((s) => [s.user_id, s.free]));
  const others = me ? (dir || []).filter((m) => m.user_id !== user.id) : [];
  const mentors = others
    .filter((m) => (!domain || m.domains.some((d) => d.includes(domain))) && (!branch || m.branch === branch))
    .sort((a, b) => (free.get(b.user_id) > 0) - (free.get(a.user_id) > 0) || Number(b.avg_rating || 0) - Number(a.avg_rating || 0));
  const allDomains = [...new Set(others.flatMap((m) => m.domains))].sort();
  const branches = [...new Set(others.map((m) => m.branch).filter(Boolean))].sort();
  const open = (reqs || []).filter((r) => r.mentee_id === user.id && ["pending", "accepted"].includes(r.status));
  const mySent = new Set(open.map((r) => r.mentor_id));
  const pendingIn = (reqs || []).filter((r) => r.mentor_id === user.id && r.status === "pending").length;
  const students = (reqs || []).filter((r) => r.mentor_id === user.id && r.status === "accepted").length;
  const now = new Date().toISOString();

  return (
    <>
      <div className="page-head">
        <div><h1>Free mentorship</h1><p>Fourth-year students guide first, second and third years for free. Request a mentor, confirm a time, and rate the session afterwards.</p></div>
        {me?.can_mentor ? <MentorProfileForm mine={mineProfile} />
          : me && mineProfile ? <RemoveMentorProfile />
          : me && !me.suspended ? <p className="audience">{me.can_ask ? "Mentoring others opens in year 4." : "Only fourth-year students can mentor."}</p> : null}
      </div>
      {!me && <p className="form-msg err">Mentorship is not set up yet. Run <code>supabase/dashboard-15-mentorship.sql</code> in the Supabase SQL editor.</p>}
      {me?.suspended && <p className="form-msg err">An admin has paused your mentoring. Contact a college admin if you think this is a mistake.</p>}
      {me?.can_mentor && mineProfile && <p className="inline-msg">You are mentoring {students} of 3 students{mineProfile.active ? "" : ". New requests are paused"}.</p>}
      {me && !me.study_year && <p className="inline-msg">Mentorship is for undergraduate students. If you are one and your college email does not show your year, ask a super-admin to set it.</p>}
      <Tabs tabs={TABS.map(([v, l]) => [v, v === "requests" && pendingIn ? `${l} (${pendingIn} new)` : l])} current={tab} base="/dashboard/mentors" />

      {tab === "find" ? (
        <>
          <form className="filters" method="get" role="search">
            <label className="sel"><span>Domain</span><input name="domain" list="domains" defaultValue={domain} placeholder="web, dsa, placements…" /><datalist id="domains">{allDomains.map((d) => <option key={d} value={d} />)}</datalist></label>
            <label className="sel"><span>Branch</span><select name="branch" defaultValue={branch}><option value="">All branches</option>{branches.map((b) => <option key={b} value={b}>{shortBranch(b)}</option>)}</select></label>
            <button className="chip on">Search</button>{(domain || branch) && <Link className="link-btn" href="/dashboard/mentors">Clear</Link>}
          </form>
          {me?.can_ask && open.length >= 2 && <p className="inline-msg">You have 2 open requests, which is the limit. Withdraw or end one to ask another mentor.</p>}
          {!mentors.length ? <div className="empty"><h2>No mentors found</h2><p>{domain || branch ? "Try another domain or branch." : "Fourth-year mentors will appear here once they sign up."}</p></div> : (
            <div className="feed">{mentors.map((m) => (
              <article key={m.user_id} className="notice" style={{ "--u": "#c58ad1" }}>
                <div className="notice-top">
                  {m.domains.map((d) => <span key={d} className="pill soft" style={{ "--c": "#c58ad1" }}>{d}</span>)}
                  <span className="when">{m.avg_rating ? <><Star size={14} style={{ verticalAlign: "-2px" }} /> {m.avg_rating} · </> : null}{m.sessions} session{m.sessions === 1 ? "" : "s"}</span>
                </div>
                <h3 className="notice-title">{m.full_name || "A senior"}</h3>
                <p className="audience">{shortBranch(m.branch)} · Year {m.year} · {free.get(m.user_id) > 0 ? `${free.get(m.user_id)} of 3 places free` : "Full for now"}{m.availability ? ` · ${m.availability}` : ""}</p>
                {m.bio && <p style={{ whiteSpace: "pre-wrap" }}>{m.bio}</p>}
                <div className="notice-actions">
                  {mySent.has(m.user_id) ? <span className="inline-msg">You have an open request with this mentor.</span>
                    : me.can_ask && open.length < 2 && free.get(m.user_id) > 0 ? <AskMentor mentorId={m.user_id} /> : null}
                  <ReportBlock kind="user" refId={m.user_id} ownerId={m.user_id} />
                </div>
              </article>
            ))}</div>
          )}
        </>
      ) : !reqs?.length ? (
        <div className="empty"><h2>No requests yet</h2><p>Requests you send, and requests you receive as a mentor, appear here.</p></div>
      ) : (
        <div className="feed">{reqs.map((r) => {
          const asMentor = r.mentor_id === user.id;
          const sessions = [...(r.mentor_sessions || [])].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
          return <RequestCard key={r.id} r={r} asMentor={asMentor} sessions={sessions} now={now} ready={!!me} person={who.get(asMentor ? r.mentee_id : r.mentor_id)} />;
        })}</div>
      )}
    </>
  );
}

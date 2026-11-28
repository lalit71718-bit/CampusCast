import Link from "next/link";
import { CalendarClock, MapPin, Wallet } from "lucide-react";
import { getPublisher } from "../../../lib/dash/ctx";
import { fmtRange, formatRupees } from "../../../lib/hackathons/status";
import { organiserLine } from "../../../lib/hackathons/organiser";
import { eventPhase } from "../../../lib/events/status";
import { categoryLabel } from "../../../lib/events/categories";
import { legacyPosters } from "../../../lib/events/posters";
import Countdown from "../../../components/dashboard/Countdown";
import { FollowChip, RsvpButtons } from "../../../components/dashboard/OfficialActions";
import { Remind, Tabs } from "../../../components/dashboard/Bits";

export const metadata = { title: "Cultural events" };
const TABS = [["upcoming", "Upcoming"], ["going", "I'm going"], ["past", "Past events"]];

export default async function Events({ searchParams }) {
  const sp = await searchParams;
  const tab = TABS.some(([v]) => v === sp.tab) ? sp.tab : "upcoming";
  const { supabase, user, canPublish } = await getPublisher();
  const nowMs = Date.now();
  const [{ data: all, error }, { data: clubs }, { data: follows }, { data: counts }, { data: rsvps }, { data: docs }] = await Promise.all([
    supabase.from("events").select("*, club:clubs(name, color)").order("starts_at", { ascending: tab !== "past" }),
    supabase.from("clubs").select("id,name,color").order("name"),
    supabase.from("club_follows").select("club_id").eq("user_id", user.id),
    supabase.rpc("event_counts"),
    supabase.from("event_rsvps").select("event_id,status").eq("user_id", user.id),
    // empty until dashboard-13 has been run; the list still works without it
    supabase.from("event_documents").select("id, event_id, mime_type").like("mime_type", "image/%").order("created_at", { ascending: false }).limit(300),
  ]);
  const followed = new Set((follows || []).map((f) => f.club_id));
  const cnt = new Map((counts || []).map((c) => [c.event_id, c]));
  const mine = new Map((rsvps || []).map((r) => [r.event_id, r.status]));
  // Drafts are listed on the "Post an event" page only. A running event stays in the current tabs until it ends.
  const data = (all || []).filter((e) => e.status !== "draft" && e.starts_at)
    .filter((e) => {
      const { over } = eventPhase(e, nowMs);
      return tab === "past" ? over : !over && (tab !== "going" || mine.get(e.id) === "going");
    });

  const posters = await legacyPosters(supabase, data);
  for (const d of [...(docs || [])].reverse()) posters.set(d.event_id, `/api/events/file/${d.id}`);

  return (
    <>
      <div className="page-head">
        <div><h1>Cultural events</h1><p>Follow clubs to hear about their events, and say whether you are interested or going.</p></div>
        {canPublish && <Link className="btn" href="/dashboard/events/manage">Post an event</Link>}
      </div>

      <section aria-label="Clubs" style={{ marginBottom: 16 }}>
        <p className="audience">CLUBS · FOLLOW TO HEAR FROM THEM</p>
        <div className="filters">{(clubs || []).map((c) => <FollowChip key={c.id} club={c} on={followed.has(c.id)} />)}</div>
      </section>

      <Tabs tabs={TABS} current={tab} base="/dashboard/events" />
      {error && <p className="form-msg err">{error.message}</p>}
      {!data.length ? <div className="empty"><h2>{tab === "going" ? "You have not marked any event as going" : "No events here"}</h2><p>Events posted by clubs and the college will appear here.</p></div> : (
        <div className="feed">{data.map((e) => {
          const c = cnt.get(e.id) || { interested: 0, going: 0 };
          const p = eventPhase(e, nowMs);
          const cancelled = e.status === "cancelled";
          const organizer = organiserLine(e);
          const poster = posters.get(e.id);
          const href = `/dashboard/events/${e.id}`;
          const upcoming = new Date(e.starts_at).getTime() > nowMs;
          return (
            <article key={e.id} className={`notice hk-card${p.over || cancelled ? " over" : ""}`} style={{ "--u": p.color }}>
              {poster && <Link className="hk-thumb" href={href} tabIndex={-1} aria-hidden="true"><img src={poster} alt="" loading="lazy" /></Link>}
              <div className="hk-body">
                <div className="notice-top">
                  <span className="pill soft hk-phase" style={{ "--c": p.color }}>{p.label}</span>
                  <span className="pill soft" style={{ "--c": "#c58ad1" }}>{categoryLabel(e.category)}</span>
                  {organizer && <span className="pill soft" style={{ "--c": e.club?.color || "#d9c8a8" }}>{organizer}</span>}
                </div>
                <h3 className="notice-title"><Link href={href}>{e.title}</Link></h3>
                {e.tagline && <p>{e.tagline}</p>}
                {p.target && <Countdown target={p.target.at} label={p.target.label} tone={p.key} compact />}
                <ul className="hk-facts">
                  <li><CalendarClock size={16} /> <span>{fmtRange(e.starts_at, e.ends_at)}</span></li>
                  {e.venue && <li><MapPin size={16} /> <span>{e.venue}</span></li>}
                  {e.fee_amount != null && <li><Wallet size={16} /> <span>{Number(e.fee_amount) === 0 ? "Free entry" : formatRupees(e.fee_amount)}</span></li>}
                </ul>
                <div className="notice-actions">
                  <Link className="btn-s" href={href}>Full details</Link>
                  {!p.over && !cancelled && <RsvpButtons id={e.id} mine={mine.get(e.id)} counts={c} />}
                  {upcoming && !cancelled && <Remind kind="event" refId={e.id} title={e.title} url={href} at={e.starts_at} />}
                  {p.over && !cancelled && <span className="inline-msg">{c.going} said going · {c.interested} were interested</span>}
                </div>
              </div>
            </article>
          );
        })}</div>
      )}
    </>
  );
}

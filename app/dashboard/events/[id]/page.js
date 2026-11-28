import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, FileText, Globe, Mail, MapPin, MessageCircle, Pencil, Phone, Share2 } from "lucide-react";
import { getPublisher } from "../../../../lib/dash/ctx";
import { isUuid } from "../../../../lib/hackathons/validate";
import { fmtDateTime, fmtRange, formatRupees, telLink, waLink } from "../../../../lib/hackathons/status";
import { organiserLine } from "../../../../lib/hackathons/organiser";
import { eventPhase } from "../../../../lib/events/status";
import { categoryLabel } from "../../../../lib/events/categories";
import { legacyPosters } from "../../../../lib/events/posters";
import Countdown from "../../../../components/dashboard/Countdown";
import ScheduleTimeline from "../../../../components/dashboard/ScheduleTimeline";
import { RsvpButtons } from "../../../../components/dashboard/OfficialActions";
import { Remind } from "../../../../components/dashboard/Bits";

export const metadata = { title: "Event" };

export default async function EventDetail({ params }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { supabase, user, isAdmin, ledClubs } = await getPublisher();
  const [{ data: e }, { data: counts }, { data: rsvp }] = await Promise.all([
    supabase.from("events").select("*, club:clubs(id, name, color)").eq("id", id).maybeSingle(),
    supabase.rpc("event_counts"),
    supabase.from("event_rsvps").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
  ]);
  if (!e) notFound();
  // The posters are a separate query, so the page still opens before dashboard-13 has been run.
  const { data: docs } = await supabase.from("event_documents").select("id, mime_type, created_at").eq("event_id", id).order("created_at");
  const status = e.status || "published";
  const canManage = isAdmin || (ledClubs || []).some((c) => c.id === e.club_id) || (e.created_by === user.id && (ledClubs || []).length > 0);
  if (status === "draft" && !canManage) notFound();

  const nowMs = Date.now();
  const p = eventPhase(e, nowMs);
  const c = (counts || []).find((x) => x.event_id === e.id) || { interested: 0, going: 0 };
  const open = status === "published" && !p.over;
  const upcoming = status === "published" && e.starts_at && new Date(e.starts_at).getTime() > nowMs;
  const regOpen = open && !(e.reg_closes_at && new Date(e.reg_closes_at).getTime() <= nowMs);
  const image = (docs || []).find((d) => d.mime_type?.startsWith("image/"));
  const poster = image ? `/api/events/file/${image.id}` : (await legacyPosters(supabase, [e])).get(e.id);
  const brochures = (docs || []).filter((d) => d.mime_type === "application/pdf");
  const organizer = organiserLine(e);
  const tel = telLink(e.contact_phone), wa = waLink(e.contact_phone, `Hi, I have a question about ${e.title}.`);
  const programme = e.details?.programme || [];
  const guests = e.details?.guests || [];
  const prizes = e.details?.prizes || [];
  // The timeline shows each entry's name, time and one line of everything else printed for it.
  const timeline = programme.map((x) => ({
    title: x.title, at: x.at,
    note: [x.venue, x.fee && `Fee: ${x.fee}`, x.prize && `Prize: ${x.prize}`, x.note].filter(Boolean).join(" · "),
  }));
  const share = [e.title + (e.tagline ? ` - ${e.tagline}` : ""), fmtRange(e.starts_at, e.ends_at), e.venue, e.website_url || e.link].filter(Boolean).join("\n");

  return (
    <div className="hk-page">
      <Link href="/dashboard/events" className="back-link"><ArrowLeft size={16} /> All events</Link>
      {status === "draft" && <p className="form-msg">This is a draft. Students cannot see it. <Link href={`/dashboard/events/manage/${e.id}`}>Open the editor to publish</Link>.</p>}
      {status === "cancelled" && <p className="form-msg err" role="status">This event was cancelled by the organisers.</p>}

      <section className="hk-hero">
        {poster && <a className="hk-poster" href={poster} target="_blank" rel="noopener noreferrer" aria-label="Open the poster"><img src={poster} alt={`Poster of ${e.title}`} /></a>}
        <div className="hk-hero-main">
          <div className="notice-top">
            <span className="pill soft hk-phase" style={{ "--c": p.color }}>{p.label}</span>
            <span className="pill soft" style={{ "--c": "#c58ad1" }}>{categoryLabel(e.category)}</span>
            {organizer && <span className="pill soft" style={{ "--c": e.club?.color || "#d9c8a8" }}>{organizer}</span>}
          </div>
          <h1>{e.title}</h1>
          {e.tagline && <p className="hk-tagline">{e.tagline}</p>}
          {p.target && <Countdown target={p.target.at} label={p.target.label} tone={p.key} detail={fmtDateTime(new Date(p.target.at).toISOString())} />}
          <div className="notice-actions">
            {open && <RsvpButtons id={e.id} mine={rsvp?.status} counts={c} />}
            {upcoming && <Remind kind="event" refId={e.id} title={e.title} url={`/dashboard/events/${e.id}`} at={e.starts_at} />}
            {p.over && status === "published" && <span className="inline-msg">{c.going} said going · {c.interested} were interested</span>}
          </div>
          {regOpen && e.link && <p className="inline-msg">Interested and Going do not register you. <a href={e.link} target="_blank" rel="noopener noreferrer">Register on the organisers&apos; form</a>.</p>}
          <div className="notice-actions">
            {regOpen && e.link && <a className="btn-s clay" href={e.link} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> Register</a>}
            {e.website_url && <a className="btn-s" href={e.website_url} target="_blank" rel="noopener noreferrer"><Globe size={16} /> Website</a>}
            {status === "published" && <a className="btn-s" href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noopener noreferrer"><Share2 size={16} /> Share on WhatsApp</a>}
            {canManage && <Link className="btn-s" href={`/dashboard/events/manage/${e.id}`}><Pencil size={14} /> Edit</Link>}
          </div>
        </div>
      </section>

      <section className="hk-grid" aria-label="Key details">
        <div className="hk-fact"><span>When</span><b>{fmtRange(e.starts_at, e.ends_at) || "To be announced"}</b></div>
        <div className="hk-fact"><span>Venue</span><b>{e.venue || "To be announced"}</b>{e.map_url && <a href={e.map_url} target="_blank" rel="noopener noreferrer"><MapPin size={14} /> Open the map</a>}</div>
        <div className="hk-fact"><span>Entry fee</span><b>{e.fee_amount == null ? (programme.some((x) => x.fee) ? "See the programme" : "Not stated") : Number(e.fee_amount) === 0 ? "Free" : formatRupees(e.fee_amount)}</b>{e.fee_note && <small>{e.fee_note}</small>}</div>
        {e.reg_closes_at && <div className="hk-fact"><span>Registration</span><b>{new Date(e.reg_closes_at).getTime() > nowMs ? "Closes" : "Closed"} {fmtDateTime(e.reg_closes_at)}</b></div>}
        {e.eligibility && <div className="hk-fact wide"><span>Who can take part</span><b>{e.eligibility}</b></div>}
      </section>

      {e.description && (
        <section className="hk-sec">
          <h2>About the event</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{e.description}</p>
        </section>
      )}

      {timeline.length > 0 && (
        <section className="hk-sec">
          <h2>Programme</h2>
          <ScheduleTimeline items={timeline} />
        </section>
      )}

      {(e.rules || guests.length > 0 || prizes.length > 0) && (
        <section className="hk-sec hk-lists">
          {e.rules && <div><h3>Rules and entry</h3><p style={{ whiteSpace: "pre-wrap" }}>{e.rules}</p></div>}
          {guests.length > 0 && <div><h3>Guests, judges and performers</h3><ul>{guests.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {prizes.length > 0 && <div><h3>Prizes and certificates</h3><ul>{prizes.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        </section>
      )}

      <section className="hk-sec hk-contact">
        <div>
          <h2>Questions?</h2>
          {e.contact_name || e.contact_phone || e.contact_email ? (
            <>
              {e.contact_name && <p className="hk-who">Contact <b>{e.contact_name}</b></p>}
              <div className="notice-actions">
                {tel && <a className="btn-s" href={tel}><Phone size={14} /> Call {e.contact_phone}</a>}
                {wa && <a className="btn-s" href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle size={14} /> WhatsApp</a>}
                {!tel && e.contact_phone && <span className="inline-msg">{e.contact_phone}</span>}
                {e.contact_email && <a className="btn-s" href={`mailto:${e.contact_email}`}><Mail size={14} /> {e.contact_email}</a>}
              </div>
            </>
          ) : <p className="inline-msg">The organisers did not share a contact number or email.</p>}
          {brochures.map((b) => <p key={b.id}><a className="btn-s" href={`/api/events/file/${b.id}`} target="_blank" rel="noopener noreferrer"><FileText size={14} /> View the brochure</a> <a className="link-btn" href={`/api/events/file/${b.id}?download=1`}>Download</a></p>)}
        </div>
      </section>
    </div>
  );
}

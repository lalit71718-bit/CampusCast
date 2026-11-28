import Link from "next/link";
import { redirect } from "next/navigation";
import { getPublisher } from "../../../../lib/dash/ctx";
import { postingClubs } from "../../../../lib/hackathons/access";
import { fmtDateTime } from "../../../../lib/hackathons/status";
import { aiConfig } from "../../../../lib/exams/config";
import EventUploader from "../../../../components/dashboard/EventUploader";

export const metadata = { title: "Post an event" };

const STATUS = { draft: ["Draft", "#d9c8a8"], published: ["Published", "#7fb48a"], cancelled: ["Cancelled", "#e8603c"] };

export default async function ManageEvents() {
  const ctx = await getPublisher();
  if (!ctx.canPublish) redirect("/dashboard/events");
  const { supabase, user, isAdmin } = ctx;
  const clubs = await postingClubs(supabase, ctx);

  // The events this person can manage: all of them for an admin; for others their clubs' and the ones they organise.
  let q = supabase.from("events")
    .select("id, title, status, club_id, organizer_name, starts_at, club:clubs(name), docs:event_documents(id, extractions:event_extractions(id, status, error, created_at))")
    .order("created_at", { ascending: false }).limit(60);
  if (!isAdmin) q = q.or([`created_by.eq.${user.id}`, ...(clubs.length ? [`club_id.in.(${clubs.map((c) => c.id).join(",")})`] : [])].join(","));
  const [{ data, error }, { data: counts }] = await Promise.all([q, supabase.rpc("event_counts")]);
  const cnt = new Map((counts || []).map((c) => [c.event_id, c]));
  const rows = (data || []).map((w) => ({ ...w, reading: (w.docs || []).flatMap((d) => d.extractions || []).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Post an event</h1>
          <p>Upload the poster or brochure (a photo from WhatsApp works). CampusCast reads it and fills in the details. You check it and publish: nobody else has to approve.</p>
        </div>
        <Link className="btn-s" href="/dashboard/events">View as a student</Link>
      </div>

      {clubs.length === 0 && !isAdmin ? (
        <div className="empty"><h2>No club assigned to you yet</h2><p>A central admin needs to make you an admin of your club before you can post events.</p></div>
      ) : (
        <EventUploader userId={user.id} clubs={clubs} isAdmin={isAdmin} aiReady={aiConfig().providers.length > 0} />
      )}

      <h2 className="sub-h">{isAdmin ? "All events" : "Your events"}</h2>
      {error && <p className="form-msg err">{/column|relationship|schema cache/i.test(error.message) ? "The database is not set up for this yet: run supabase/dashboard-13-events.sql in the Supabase SQL editor." : error.message}</p>}
      {!rows.length ? <div className="empty"><h2>Nothing posted yet</h2><p>Upload a poster above and it will appear here.</p></div> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Event</th><th>Organiser</th><th>RSVPs</th><th>Reading</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((w) => {
              const [label, color] = STATUS[w.status] || STATUS.draft;
              const x = w.reading, c = cnt.get(w.id);
              return (
                <tr key={w.id}>
                  <td><b>{w.title}</b><small>{w.starts_at ? fmtDateTime(w.starts_at) : "No date yet"}</small></td>
                  <td>{w.club?.name || w.organizer_name || "—"}</td>
                  <td>{c?.going || 0} going{c?.interested ? <small>{c.interested} interested</small> : null}</td>
                  <td>{!x ? "—" : x.status === "completed" ? <span className="pill soft" style={{ "--c": "#7fb48a" }}>Read</span> : x.status === "failed" ? <span className="pill soft" style={{ "--c": "#e8603c" }} title={x.error || ""}>Failed</span> : <span className="inline-msg">Reading…</span>}</td>
                  <td><span className="pill soft" style={{ "--c": color }}>{label}</span></td>
                  <td className="row-actions"><Link className="btn-s" href={`/dashboard/events/manage/${w.id}`}>{w.status === "draft" ? "Review" : "Edit"}</Link>{w.status !== "draft" && <Link className="btn-s ghost" href={`/dashboard/events/${w.id}`}>View</Link>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getPublisher } from "../../../../../lib/dash/ctx";
import { postingClubs } from "../../../../../lib/hackathons/access";
import { isUuid } from "../../../../../lib/hackathons/validate";
import EventEditor from "../../../../../components/dashboard/EventEditor";

export const metadata = { title: "Edit event" };

export default async function EditEvent({ params }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await getPublisher();
  if (!ctx.canPublish) redirect("/dashboard/events");
  const { supabase, user, isAdmin } = ctx;

  const [{ data: ev }, { data: docs }] = await Promise.all([
    supabase.from("events").select("*, club:clubs(id, name)").eq("id", id).maybeSingle(),
    supabase.from("event_documents").select("id, original_filename, storage_path, mime_type, created_at, extractions:event_extractions(id, status, error, field_meta, created_at)").eq("event_id", id).order("created_at"),
  ]);
  if (!ev) notFound();
  const clubs = await postingClubs(supabase, ctx);
  if (!isAdmin && ev.created_by !== user.id && !clubs.some((c) => c.id === ev.club_id)) redirect("/dashboard/events");   // someone else's club

  const doc = docs?.[0] || null;
  let url = null;
  if (doc) {
    const { data: signed } = await supabase.storage.from("event-files").createSignedUrl(doc.storage_path, 3600);
    url = signed?.signedUrl || null;
  }
  // A poster added with the older form has no document row: show it from the event-media bucket.
  let old = null;
  if (!doc && ev.poster?.path) {
    const { data: signed } = await supabase.storage.from("event-media").createSignedUrl(ev.poster.path, 3600);
    old = { url: signed?.signedUrl || null, filename: ev.poster.name, mime: ev.poster.type || "image/jpeg" };
  }
  const latest = doc ? [...(doc.extractions || [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null : null;
  const ex = ev.details?.extraction;

  return (
    <>
      <Link href="/dashboard/events/manage" className="back-link"><ArrowLeft size={16} /> All my events</Link>
      <EventEditor
        key={ex?.appliedAt || "manual"}
        ev={ev}
        meta={latest?.field_meta || {}}
        applyError={latest?.field_meta?._applyError || ""}
        warnings={ex?.warnings || []}
        autofilled={Boolean(ex?.autofilled)}
        qrLinks={ex?.qrLinks || []}
        poster={doc ? { url, filename: doc.original_filename, mime: doc.mime_type } : old}
        clubs={clubs}
        isAdmin={isAdmin}
        reading={latest && { status: latest.status, error: latest.error }}
      />
    </>
  );
}

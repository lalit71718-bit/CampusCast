"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getPublisher } from "../../../../lib/dash/ctx";
import { postingClubs } from "../../../../lib/hackathons/access";
import { isUuid } from "../../../../lib/hackathons/validate";
import { aiConfig } from "../../../../lib/exams/config";
import { sniffFile } from "../../../../lib/exams/pdf";
import { STALE_PROCESSING_MS } from "../../../../lib/exams/constants";
import { clean } from "../../../../lib/exams/normalize";
import { publishIssues, validateEvent } from "../../../../lib/events/validate";
import { applyEventPatch, describeApplyFailure, planEventApply } from "../../../../lib/events/plan";

const BUCKET = "event-files";
const HEX64 = /^[0-9a-f]{64}$/;
const UPLOADS_PER_HOUR = 30;   // a simple guard on AI cost
const message = (e) => (e?.message ? String(e.message).slice(0, 240) : "Something went wrong.");

// Every action below runs as the signed-in person. Row-level security decides what they may touch.
async function publisher() {
  const ctx = await getPublisher();
  if (!ctx.canPublish) return { error: "Only club admins and admins can post events." };
  return { ctx, clubs: await postingClubs(ctx.supabase, ctx) };
}
const refresh = (id) => {
  revalidatePath("/dashboard/events"); revalidatePath("/dashboard/events/manage"); revalidatePath("/dashboard/calendar");
  if (id) revalidatePath(`/dashboard/events/${id}`);
};
const clubProblem = (p, clubId) => {
  if (clubId && !p.clubs.some((c) => c.id === clubId)) return "You can only post for a club you lead.";
  if (!clubId && !p.ctx.isAdmin) return "Choose the club that is organising this event.";
  return null;
};

export async function checkEventDuplicate(sha256) {
  const p = await publisher();
  const sha = String(sha256 || "").toLowerCase();
  if (p.error || !HEX64.test(sha)) return { duplicates: [] };
  const { data } = await p.ctx.supabase.rpc("event_find_duplicates", { p_sha256: sha });
  return { duplicates: (data || []).map((d) => ({ id: d.event_id, title: d.title, status: d.status })) };
}

// Called after the browser has uploaded the file straight into storage. Checks the file, then creates the DRAFT
// event, its document row and a queued reading. The browser then starts the reading (/api/events/extract).
export async function registerEventUpload({ path, filename, clubId, allowDuplicate = false }) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  const { supabase, user } = p.ctx;

  const folder = `${user.id}/`;
  if (typeof path !== "string" || !path.startsWith(folder) || !/^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/i.test(path.slice(folder.length))) return { error: "Invalid upload." };
  // A file that is already attached to an event is never removed by a failed second registration.
  const { count: used } = await supabase.from("event_documents").select("id", { count: "exact", head: true }).eq("storage_path", path);
  if (used) return { error: "That upload is already saved." };
  const fail = async (error) => { await supabase.storage.from(BUCKET).remove([path]); return { error }; };
  const bad = clubProblem(p, clubId);
  if (bad) return fail(bad);

  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await supabase.from("event_documents").select("id", { count: "exact", head: true }).eq("uploaded_by", user.id).gte("created_at", since);
  if ((count || 0) >= UPLOADS_PER_HOUR) return fail("Too many uploads in the last hour. Please try again later.");

  // Read the stored file back and check it on the server: never trust what the browser says about it.
  const { data: file, error: dlErr } = await supabase.storage.from(BUCKET).download(path);
  if (dlErr || !file) return { error: "The upload was not found. Please try again." };
  const bytes = Buffer.from(await file.arrayBuffer());
  const sniff = sniffFile(bytes);
  if (!sniff.ok) return fail(sniff.message);
  if (!path.toLowerCase().endsWith(`.${sniff.ext}`)) return fail("The file does not match its type. Please upload it again.");
  const sha = createHash("sha256").update(bytes).digest("hex");

  const { data: dups } = await supabase.rpc("event_find_duplicates", { p_sha256: sha });
  if (dups?.length && !allowDuplicate) return fail("This exact file has already been uploaded.");

  const name = clean(String(filename || "poster"), 160) || "poster";
  const title = clean(name.replace(/\.(pdf|jpe?g|png|webp)$/i, "").replace(/[_-]+/g, " "), 140);
  const { data: w, error: wErr } = await supabase.from("events")
    .insert({ title: title.length >= 3 ? title : "New event", club_id: clubId || null, status: "draft", created_by: user.id })
    .select("id").single();
  if (wErr) return fail(message(wErr));
  const undo = async (e) => { await supabase.from("events").delete().eq("id", w.id); return fail(message(e)); };

  const { data: doc, error: dErr } = await supabase.from("event_documents")
    .insert({ event_id: w.id, storage_path: path, original_filename: name, mime_type: sniff.mime, size_bytes: bytes.length, sha256: sha, page_count: sniff.pageCount, uploaded_by: user.id })
    .select("id").single();
  if (dErr) return undo(dErr);
  const { data: ex, error: xErr } = await supabase.from("event_extractions").insert({ document_id: doc.id, status: "queued", model: aiConfig().model }).select("id").single();
  if (xErr) return undo(xErr);
  refresh();
  return { eventId: w.id, documentId: doc.id, extractionId: ex.id };
}

// A failed (or stuck) reading gets a fresh attempt. The old row stays as the record of what happened.
export async function retryEventExtraction(extractionId) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  if (!isUuid(extractionId)) return { error: "Invalid request." };
  const { supabase } = p.ctx;
  const { data: old } = await supabase.from("event_extractions").select("id, document_id, status, attempt, started_at").eq("id", extractionId).maybeSingle();
  if (!old) return { error: "That reading was not found." };
  const stuck = old.status === "processing" && old.started_at && Date.now() - new Date(old.started_at).getTime() > STALE_PROCESSING_MS;
  if (old.status !== "failed" && !stuck) return { error: "Only a failed reading can be retried." };
  const { data: next, error } = await supabase.from("event_extractions")
    .insert({ document_id: old.document_id, status: "queued", attempt: (old.attempt || 1) + 1, model: aiConfig().model }).select("id").single();
  if (error) return { error: message(error) };
  return { extractionId: next.id };
}

// Fills the form again from the saved AI reading (no new AI call). It replaces what is in the form, so the editor asks first.
export async function reapplyEventReading(eventId) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  if (!isUuid(eventId)) return { error: "Invalid request." };
  const { supabase } = p.ctx;
  const { data: w } = await supabase.from("events").select("id, status, club_id, starts_at, details").eq("id", eventId).maybeSingle();
  if (!w) return { error: "That event was not found." };
  if (w.status !== "draft") return { error: "Only a draft can be filled again." };
  const { data: docs } = await supabase.from("event_documents").select("id").eq("event_id", eventId);
  const ids = (docs || []).map((d) => d.id);
  if (!ids.length) return { error: "There is no uploaded poster to read." };
  const { data: exs } = await supabase.from("event_extractions").select("id, result, field_meta, created_at").in("document_id", ids).eq("status", "completed").order("created_at", { ascending: false }).limit(1);
  const ex = exs?.[0];
  if (!ex?.result) return { error: "The poster has not been read successfully yet." };
  const { warnings = [], ...result } = ex.result;
  const fieldMeta = Object.fromEntries(Object.entries(ex.field_meta || {}).filter(([k]) => !k.startsWith("_")));
  const plan = planEventApply(w, { result, warnings, fieldMeta }, { extractionId: ex.id, clubs: p.clubs, force: true });
  const done = await applyEventPatch(supabase, eventId, plan.patch);
  await supabase.from("event_extractions").update({ field_meta: done.ok ? fieldMeta : { ...fieldMeta, _applyError: describeApplyFailure(done.failed).slice(0, 400) } }).eq("id", ex.id);
  refresh(eventId);
  if (!done.ok) return { error: describeApplyFailure(done.failed) };
  return { ok: true };
}

// A new, empty draft for someone who has no poster to upload.
export async function createBlankEvent({ clubId }) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  const bad = clubProblem(p, clubId);
  if (bad) return { error: bad };
  const { data, error } = await p.ctx.supabase.from("events").insert({ title: "New event", club_id: clubId || null, status: "draft", created_by: p.ctx.user.id }).select("id").single();
  if (error) return { error: message(error) };
  refresh();
  return { eventId: data.id };
}

// Save everything on the editor. `data` is the form; it is validated here again.
export async function saveEvent({ id, data }) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  if (!isUuid(id)) return { error: "Invalid request." };
  const { supabase, isAdmin } = p.ctx;
  const { data: current } = await supabase.from("events").select("id, status, details").eq("id", id).maybeSingle();
  if (!current) return { error: "That event was not found." };
  const v = validateEvent(data, { clubs: p.clubs, isAdmin });
  if (!v.ok) return { error: v.errors[0], errors: v.errors };
  if (current.status !== "draft" && !v.patch.starts_at) return { error: "A published event needs a date and start time." };
  const { data: saved, error } = await supabase.from("events").update({ ...v.patch, details: { ...(current.details || {}), ...v.details } }).eq("id", id).select("id");
  if (error) return { error: message(error) };
  if (!saved?.length) return { error: "You cannot edit this event." };
  refresh(id);
  return { ok: true };
}

// Publish, unpublish (back to a draft) or cancel. Publishing needs no approval: the organiser does it directly.
export async function setEventStatus({ id, status }) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  if (!isUuid(id) || !["draft", "published", "cancelled"].includes(status)) return { error: "Invalid request." };
  const { supabase } = p.ctx;
  const { data: w } = await supabase.from("events").select("*").eq("id", id).maybeSingle();
  if (!w) return { error: "That event was not found." };
  if (status === "published") {
    const { blocking } = publishIssues(w);
    if (blocking.length) return { error: blocking[0], errors: blocking };
  }
  const { data: saved, error } = await supabase.from("events").update({ status }).eq("id", id).select("id");
  if (error) return { error: message(error) };
  if (!saved?.length) return { error: "You cannot change this event." };
  refresh(id);
  return { ok: true };
}

// Remove a draft or a cancelled event, with its files.
export async function removeEvent(id) {
  const p = await publisher();
  if (p.error) return { error: p.error };
  if (!isUuid(id)) return { error: "Invalid request." };
  const { supabase } = p.ctx;
  const { data: w } = await supabase.from("events").select("id, status, poster").eq("id", id).maybeSingle();
  if (!w) return { error: "That event was not found." };
  if (w.status === "published") return { error: "Cancel a published event before removing it." };
  const { data: docs } = await supabase.from("event_documents").select("storage_path").eq("event_id", id);
  const { data: gone, error } = await supabase.from("events").delete().eq("id", id).select("id");
  if (error) return { error: message(error) };
  if (!gone?.length) return { error: "You cannot remove this event." };
  const paths = (docs || []).map((d) => d.storage_path);
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
  // A poster added with the older form lives in the event-media bucket.
  if (w.poster?.path) await supabase.storage.from("event-media").remove([w.poster.path]);
  refresh();
  return { ok: true };
}

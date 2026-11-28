import { MAX_DETAILS_BYTES, bytesOf } from "./categories.js";

// Decides what to write into a DRAFT event after the AI has read its poster, and writes it. It fills the draft once;
// after that the organiser's edits are never overwritten. It never touches status, and nothing here publishes anything.

/**
 * @param event  { id, club_id, starts_at, details }  the current draft row
 * @param norm   the result of normalizeEvent() (.result, .warnings)
 * @returns { skip: true } | { patch, warnings }
 */
export function planEventApply(event, norm, { extractionId, clubs = [], now = new Date(), force = false } = {}) {
  if (!force && event.details?.extraction?.autofilled) return { skip: true };
  const r = norm.result;
  const warnings = [...norm.warnings];
  const patch = {};
  const put = (k, v) => { if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) patch[k] = v; };

  put("title", r.name);
  put("tagline", r.tagline);
  put("category", r.category);
  put("description", r.description);
  put("organizer_name", r.organizerName);
  put("venue", r.venue);
  put("map_url", r.mapUrl);
  put("starts_at", r.startsAt);
  put("ends_at", r.endsAt);
  put("reg_closes_at", r.deadline);
  put("fee_amount", r.feeAmount);
  put("fee_note", r.feeNote);
  put("eligibility", r.eligibility);
  put("rules", r.rules);
  put("contact_name", r.contactName);
  put("contact_phone", r.contactPhone);
  put("contact_email", r.contactEmail);
  put("website_url", r.websiteUrl);
  put("link", r.registrationUrl);

  // Keep the dates sensible when only some of them are filled in.
  const starts = patch.starts_at ?? event.starts_at;
  if (starts && patch.ends_at && new Date(patch.ends_at) < new Date(starts)) delete patch.ends_at;
  const last = patch.ends_at ?? starts;
  if (last && patch.reg_closes_at && new Date(patch.reg_closes_at) > new Date(last)) {
    delete patch.reg_closes_at;
    warnings.push({ field: "registrationDeadline", code: "closes_after_end", message: "The last date to register is after the event, so it was left empty. Please check." });
  }

  // The club is chosen by the person who uploaded; it is only filled in when none was chosen and the poster names one.
  if (!event.club_id && r.clubName) {
    const c = clubs.find((x) => x.name === r.clubName);
    if (c) patch.club_id = c.id;
  }
  const details = {
    ...(event.details || {}),
    programme: [...r.programme], guests: r.guests, prizes: r.prizes,
    extraction: { autofilled: true, extractionId, requiresReview: true, warnings, qrLinks: r.qrLinks || [], appliedAt: now.toISOString() },
  };
  let cut = false;
  while (details.programme.length && bytesOf(details) > MAX_DETAILS_BYTES) { details.programme.pop(); cut = true; }
  if (cut) warnings.push({ field: "programme", code: "programme_too_long", message: `The programme was too long to save in full: ${details.programme.length} entries were kept.` });
  patch.details = details;
  return { patch, warnings };
}

/** One update with everything; if the database refuses, one field at a time so everything that can be saved is saved. */
export async function applyEventPatch(supabase, id, patch) {
  const update = (obj) => supabase.from("events").update(obj).eq("id", id);
  if (!(await update(patch)).error) return { ok: true, saved: Object.keys(patch), failed: [] };
  const saved = [], failed = [];
  const keys = [...Object.keys(patch).filter((k) => k !== "details"), ...(patch.details ? ["details"] : [])];
  for (const key of keys) {
    const { error } = await update({ [key]: patch[key] });
    if (error) failed.push({ key, message: String(error.message || error).slice(0, 160) }); else saved.push(key);
  }
  return { ok: failed.length === 0, saved, failed };
}

export function describeApplyFailure(failed) {
  if (!failed?.length) return "";
  const missing = failed.filter((f) => /column|schema cache/i.test(f.message));
  if (missing.length) return `The database is missing some columns (${missing.map((f) => f.key).join(", ")}). Run supabase/dashboard-13-events.sql in the Supabase SQL editor, then press "Fill the form from the AI reading".`;
  return `These fields could not be filled in: ${failed.map((f) => f.key).join(", ")}. ${failed[0].message}`;
}

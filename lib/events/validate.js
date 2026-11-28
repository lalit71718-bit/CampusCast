import { cleanEmail, cleanPhone, cleanUrl } from "../hackathons/normalize.js";
import { isUuid, toIso } from "../hackathons/validate.js";
import { CATEGORIES, ITEM_LIMITS, MAX_DETAILS_BYTES, MAX_ITEMS, bytesOf } from "./categories.js";

// Server-side checks for what an organiser saves from the event editor. The browser's form is never trusted, and the
// database enforces the same rules again. A bad typed value is refused with a message, not silently dropped.

const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "");
const orNull = (s) => (s ? s : null);
const lines = (v, maxItems, maxLen) => (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((x) => text(x, maxLen)).filter(Boolean).slice(0, maxItems);

/**
 * @returns { ok: true, patch, details } | { ok: false, errors: string[] }
 */
export function validateEvent(input, { clubs = [], isAdmin = false } = {}) {
  const errors = [];
  const i = input && typeof input === "object" ? input : {};
  const err = (m) => errors.push(m);

  const title = text(i.title, 140);
  if (title.length < 3) err("Give the event a name (at least 3 characters).");
  let clubId = null;
  if (i.clubId) {
    if (!isUuid(i.clubId) || !clubs.some((c) => c.id === i.clubId)) err("Choose one of your clubs.");
    else clubId = i.clubId;
  } else if (!isAdmin) err("Choose the club that is organising this event.");

  const when = {};
  for (const [key, label] of [["startsAt", "start time"], ["endsAt", "end time"], ["deadline", "last time to register"]]) {
    const raw = i[key];
    if (raw === "" || raw === null || raw === undefined) { when[key] = null; continue; }
    when[key] = toIso(raw);
    if (!when[key]) err(`The ${label} is not a real date and time.`);
  }
  const t = (k) => (when[k] ? new Date(when[k]).getTime() : null);
  if (t("startsAt") && t("endsAt") && t("endsAt") < t("startsAt")) err("The event cannot end before it starts.");
  const last = t("endsAt") ?? t("startsAt");
  if (last && t("deadline") && t("deadline") > last) err("Registration cannot close after the event is over.");

  let fee = null;
  if (i.feeFree) fee = 0;
  else if (i.feeAmount !== "" && i.feeAmount !== null && i.feeAmount !== undefined) {
    const n = Number(String(i.feeAmount).replace(/[,\s₹]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 1e6) err("The fee must be an amount in rupees (or choose Free).");
    else fee = Math.round(n * 100) / 100;
  }

  const rows = Array.isArray(i.programme) ? i.programme : [];
  const programme = [];
  rows.forEach((row, n) => {
    const x = row && typeof row === "object" ? row : {};
    const item = Object.fromEntries(Object.entries(ITEM_LIMITS).map(([k, max]) => [k, text(x[k], max)]));
    const raw = x.at;
    const at = raw ? toIso(raw) : null;
    if (!at && !raw && !Object.values(item).some(Boolean)) return;       // an empty row is simply left out
    if (!item.title) err(`Programme entry ${n + 1} needs a name.`);
    if (raw && !at) err(`Programme entry ${n + 1}: the time is not a real date and time.`);
    programme.push({ ...item, at });
  });
  if (programme.length > MAX_ITEMS) err(`The programme can have at most ${MAX_ITEMS} entries.`);

  const phone = text(i.contactPhone, 40), mail = text(i.contactEmail, 120);
  const contactPhone = phone ? cleanPhone(phone) : null, contactEmail = mail ? cleanEmail(mail) : null;
  if (phone && !contactPhone) err("The contact phone number does not look right. Use digits, with +91 or the area code if you like.");
  if (mail && !contactEmail) err("The contact email address does not look right.");
  const url = (v, label) => { const s = text(v, 500); if (!s) return null; const u = cleanUrl(s); if (!u) err(`The ${label} must be a web address (https://...).`); return u; };
  const websiteUrl = url(i.websiteUrl, "website link"), link = url(i.link, "registration link"), mapUrl = url(i.mapUrl, "map link");

  const details = { programme, guests: lines(i.guests, 20, 120), prizes: lines(i.prizes, 20, 160) };
  if (!errors.length && bytesOf(details) > MAX_DETAILS_BYTES) err("The programme, guests and prizes are too long. Please shorten them.");

  if (errors.length) return { ok: false, errors: errors.slice(0, 12) };
  return {
    ok: true,
    patch: {
      title, tagline: orNull(text(i.tagline, 160)), category: CATEGORIES.some(([k]) => k === i.category) ? i.category : null,
      description: orNull(text(i.description, 4000)), club_id: clubId, organizer_name: orNull(text(i.organizerName, 120)),
      venue: orNull(text(i.venue, 200)), map_url: mapUrl,
      starts_at: when.startsAt, ends_at: when.endsAt, reg_closes_at: when.deadline,
      fee_amount: fee, fee_note: orNull(text(i.feeNote, 200)),
      eligibility: orNull(text(i.eligibility, 300)), rules: orNull(text(i.rules, 1500)),
      contact_name: orNull(text(i.contactName, 80)), contact_phone: contactPhone, contact_email: contactEmail,
      website_url: websiteUrl, link,
    },
    details,
  };
}

/** Before publishing. `blocking` must be fixed; `hints` are things students will wonder about. */
export function publishIssues(e, nowMs = Date.now()) {
  const blocking = [], hints = [];
  if (!e.title || e.title.length < 3) blocking.push("Add the event's name.");
  if (!e.starts_at) blocking.push("Add the date and start time.");
  else if (new Date(e.ends_at || e.starts_at).getTime() <= nowMs) hints.push("The date has passed: students may see it under Past.");
  if (!e.venue) hints.push("No venue: students will not know where to go.");
  if (!e.club_id && !e.organizer_name) hints.push("No organiser is named.");
  if (!e.description && !(e.details?.programme || []).length) hints.push("Nothing says what happens at the event.");
  if (e.fee_amount == null && !e.fee_note && !(e.details?.programme || []).some((x) => x.fee)) hints.push("The entry fee is not stated.");
  if (!e.contact_phone && !e.contact_email) hints.push("No contact number or email for questions.");
  return { blocking, hints };
}

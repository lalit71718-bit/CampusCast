import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../../lib/events/normalize.js";
import { planEventApply } from "../../lib/events/plan.js";
import { publishIssues, validateEvent } from "../../lib/events/validate.js";
import { eventPhase } from "../../lib/events/status.js";
import { runEventExtraction } from "../../lib/events/process.js";
import { EVENT_TOOL } from "../../lib/events/task.js";
import { MAX_DETAILS_BYTES, MAX_ITEMS, bytesOf } from "../../lib/events/categories.js";

const NOW = new Date("2026-11-28T10:00:00+05:30");
const CLUB = { id: "11111111-1111-1111-1111-111111111111", name: "Dance Club" };
const f = (value, over = {}) => ({ value, source: value === null ? "missing" : "explicit", confidence: value === null ? 0 : 0.95, pages: [1], evidence: "", ...over });
const ITEM = { name: "Solo dance", startsAt: "2026-12-12 11:00", venue: "Stage 1", fee: "Rs. 100", prize: "Rs. 5,000", note: "One performer" };
const raw = (over = {}) => {
  const values = {
    name: "Utsav 2026", tagline: "Colours of campus", category: "fest", description: "The annual cultural fest.", organizer: "Dance Club, BMSIT", clubName: "Dance Club",
    startsAt: "12/12/2026 10:00 AM", endsAt: "2026-12-13 18:00", registrationDeadline: "10/12/2026", venue: "Main ground", mapLink: null,
    feeAmount: null, feeNote: null, eligibility: "All students", rules: "Carry your ID", programme: [ITEM, { ...ITEM, name: "Band battle", startsAt: "evening" }, { ...ITEM, name: "" }],
    guests: ["A singer"], prizes: ["Trophy"], contactName: "Ravi", contactPhone: "+91 98450 12345", contactEmail: "club@bmsit.in",
    websiteUrl: null, registrationUrl: "www.example.com/join", qrCodeLabel: null, ...over,
  };
  return { documentKind: "scanned", event: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, f(v)])) };
};
const norm = (over, opts = {}) => normalizeEvent(raw(over), { clubs: [CLUB], now: NOW, ...opts });

test("a poster's details and programme are read, with Indian day-first dates", () => {
  const { result: r, fieldMeta } = norm();
  assert.equal(r.startsAt, "2026-12-12T10:00:00+05:30");
  assert.equal(r.deadline, "2026-12-10T23:59:00+05:30");
  assert.equal(r.category, "fest");
  assert.equal(r.clubName, "Dance Club");
  assert.equal(r.programme.length, 2);                          // the nameless entry is dropped
  assert.equal(r.programme[0].at, "2026-12-12T11:00:00+05:30");
  assert.equal(r.programme[1].at, null);
  assert.match(r.programme[1].note, /^evening/);                // an unreadable time is kept as text, not guessed
  assert.equal(fieldMeta.name.needsReview, false);
  assert.equal(fieldMeta.registrationDeadline.needsReview, true);
});

test("bad or invented values are dropped and flagged", () => {
  const { result: r, warnings } = norm({ category: "rave", contactPhone: "call us", websiteUrl: "javascript:alert(1)", clubName: "Hackers", organizer: "Someone", endsAt: "2026-12-01 10:00", programme: "none" });
  assert.equal(r.category, null);
  assert.equal(r.contactPhone, null);
  assert.equal(r.websiteUrl, null);
  assert.equal(r.clubName, null);
  assert.equal(r.endsAt, null);
  assert.deepEqual(r.programme, []);
  assert.ok(warnings.some((w) => w.code === "ends_before_start"));
});

test("a long programme is capped", () => {
  const { result: r, warnings } = norm({ programme: Array.from({ length: 50 }, (_, i) => ({ ...ITEM, name: `Item ${i}` })) });
  assert.equal(r.programme.length, MAX_ITEMS);
  assert.ok(warnings.some((w) => w.code === "programme_cut"));
});

test("a QR code fills the registration link only when none is printed", () => {
  assert.equal(norm({ registrationUrl: null }, { qrLinks: ["https://forms.example.org/a"] }).result.registrationUrl, "https://forms.example.org/a");
  assert.equal(norm({}, { qrLinks: ["https://forms.example.org/a"] }).result.registrationUrl, "https://www.example.com/join");
});

test("an answer in the wrong shape is refused", () => assert.equal(normalizeEvent({ nope: 1 }).ok, false));

test("the draft is filled once, without status, and keeps the chosen club", () => {
  const draft = { club_id: "chosen", starts_at: null, details: {} };
  const { patch } = planEventApply(draft, norm({ registrationDeadline: "20/12/2026" }), { clubs: [CLUB], extractionId: "x" });
  assert.equal("status" in patch, false);
  assert.equal("club_id" in patch, false);
  assert.equal("reg_closes_at" in patch, false);                // after the event is over
  assert.equal(patch.details.programme.length, 2);
  assert.deepEqual(patch.details.guests, ["A singer"]);
  assert.equal(planEventApply({ ...draft, details: patch.details }, norm()).skip, true);
  assert.equal(planEventApply({ details: {} }, norm(), { clubs: [CLUB] }).patch.club_id, CLUB.id);
});

test("a very large programme is trimmed to fit the database", () => {
  const long = "ಕ".repeat(200);
  const n = norm({ programme: Array.from({ length: MAX_ITEMS }, () => ({ name: long, startsAt: null, venue: long, fee: long, prize: long, note: long })), guests: Array(20).fill(long), prizes: Array(20).fill(long) });
  const { patch, warnings } = planEventApply({ details: {} }, n);
  assert.ok(bytesOf(patch.details) <= MAX_DETAILS_BYTES + 2000);
  assert.ok(patch.details.programme.length < MAX_ITEMS);
  assert.ok(warnings.some((w) => w.code === "programme_too_long"));
});

const form = (over = {}) => ({ title: "Utsav 2026", clubId: CLUB.id, startsAt: "2026-12-12T10:00", endsAt: "", deadline: "", feeFree: true, category: "nope", programme: [{ title: "Solo", at: "2026-12-12T11:00" }, { title: "", at: "" }], guests: "a\n\nb", ...over });

test("the editor's values are checked again on the server", () => {
  const ok = validateEvent(form(), { clubs: [CLUB] });
  assert.equal(ok.ok, true);
  assert.equal(ok.patch.starts_at, "2026-12-12T10:00:00+05:30");
  assert.equal(ok.patch.category, null);
  assert.equal(ok.details.programme.length, 1);
  assert.deepEqual(ok.details.guests, ["a", "b"]);
  assert.equal("status" in ok.patch, false);
  for (const bad of [{ title: "x" }, { clubId: "" }, { clubId: "22222222-2222-2222-2222-222222222222" }, { endsAt: "2026-12-11T10:00" }, { deadline: "2026-12-13T10:00" }, { link: "javascript:x" }, { feeFree: false, feeAmount: "abc" }, { programme: [{ venue: "Hall" }] }, { programme: [{ title: "Solo", at: "soon" }] }]) {
    assert.equal(validateEvent(form(bad), { clubs: [CLUB] }).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateEvent(form({ clubId: "" }), { clubs: [CLUB], isAdmin: true }).ok, true);
  assert.equal(validateEvent(form({ endsAt: "2026-12-14T10:00", deadline: "2026-12-13T10:00" }), { clubs: [CLUB] }).ok, true);   // during a fest
});

test("publishing needs a date", () => {
  assert.ok(publishIssues({ title: "Utsav", starts_at: null }).blocking.length);
  assert.equal(publishIssues({ title: "Utsav", starts_at: "2026-12-12T10:00:00+05:30" }, NOW.getTime()).blocking.length, 0);
});

test("an event's phase and countdown follow the clock", () => {
  const e = { starts_at: "2026-12-12T10:00:00+05:30", ends_at: "2026-12-12T18:00:00+05:30", reg_closes_at: "2026-12-10T18:00:00+05:30" };
  const at = (t, over = {}) => eventPhase({ ...e, ...over }, new Date(t).getTime());
  assert.equal(at("2026-11-28T10:00:00+05:30").target.label, "Registration closes in");
  assert.equal(at("2026-12-09T10:00:00+05:30").key, "closing");
  assert.equal(at("2026-12-11T10:00:00+05:30").target.label, "Starts in");
  assert.equal(at("2026-12-12T12:00:00+05:30").target.label, "Ends in");
  assert.equal(at("2026-12-12T19:00:00+05:30").over, true);
  assert.equal(at("2026-11-28T10:00:00+05:30", { reg_closes_at: null }).target.label, "Starts in");
  // no end time: running for three hours, with nothing invented to count down to
  assert.equal(at("2026-12-12T12:00:00+05:30", { ends_at: null }).target, null);
  assert.equal(at("2026-12-12T12:00:00+05:30", { ends_at: null }).over, false);
  assert.equal(at("2026-12-12T13:30:00+05:30", { ends_at: null }).over, true);
  const cancelled = at("2026-11-28T10:00:00+05:30", { status: "cancelled" });
  assert.equal(cancelled.key, "cancelled");
  assert.equal(cancelled.over, false);
});

// A small stand-in for the Supabase client: just the calls one reading makes.
function world(status = "draft") {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]);
  const rows = {
    event_extractions: { id: "x1", document_id: "d1", status: "queued" },
    event_documents: { id: "d1", event_id: "e1", storage_path: "u/f.jpg", original_filename: "p.jpg", page_count: null },
    events: { id: "e1", status, club_id: null, starts_at: null, details: {} },
    clubs: [CLUB],
  };
  const from = (table) => {
    let patch = null;
    const done = async () => { if (patch) Object.assign(rows[table], patch); return { data: rows[table], error: null }; };
    const b = { select: () => b, update: (p) => { patch = p; return b; }, eq: () => b, or: () => b, order: () => b, single: done, maybeSingle: done, then: (a, c) => done().then(a, c) };
    return b;
  };
  return { rows, supabase: { from, storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length) }, error: null }) }) } } };
}
const answer = async () => ({ ok: true, status: 200, json: async () => ({ model: "m", stop_reason: "tool_use", content: [{ type: "tool_use", name: EVENT_TOOL.name, input: raw() }] }) });
const read = (supabase, fetchImpl) => runEventExtraction({ supabase, extractionId: "x1", providers: [{ provider: "anthropic", apiKey: "k", model: "m" }], fetchImpl, sleep: async () => {}, now: NOW });

test("a poster is read and the draft is filled, never published", async () => {
  const { rows, supabase } = world();
  assert.deepEqual(await read(supabase, answer), { state: "completed" });
  assert.equal(rows.event_extractions.status, "completed");
  assert.equal(rows.events.title, "Utsav 2026");
  assert.equal(rows.events.details.programme.length, 2);
  assert.equal(rows.events.status, "draft");
});

test("a published event is not overwritten by a late reading", async () => {
  const { rows, supabase } = world("published");
  await read(supabase, answer);
  assert.equal(rows.events.title, undefined);
});

test("a provider failure is recorded", async () => {
  const { rows, supabase } = world();
  const out = await read(supabase, async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "no" } }) }));
  assert.equal(out.state, "failed");
  assert.equal(rows.event_extractions.status, "failed");
});

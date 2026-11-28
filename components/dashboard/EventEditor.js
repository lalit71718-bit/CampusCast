"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink, LoaderCircle, Megaphone, Plus, Save, Trash2, Undo2, XCircle } from "lucide-react";
import { reapplyEventReading, removeEvent, saveEvent, setEventStatus } from "../../app/dashboard/events/manage/actions";
import { publishIssues, validateEvent } from "../../lib/events/validate";
import { CATEGORIES, MAX_ITEMS } from "../../lib/events/categories";
import { toLocalInput } from "../../lib/hackathons/validate";
import { organiserAfterClubChange } from "../../lib/hackathons/organiser";

const STATUS = { draft: ["Draft: students cannot see it", "#d9c8a8"], published: ["Published: students can see it", "#7fb48a"], cancelled: ["Cancelled: students see it as cancelled", "#e8603c"] };
// the editor's field -> the name the AI reading used for it, so "Check" badges show on the right fields
const META = {
  title: "name", tagline: "tagline", category: "category", description: "description", clubId: "clubName", organizerName: "organizer",
  venue: "venue", mapUrl: "mapLink", startsAt: "startsAt", endsAt: "endsAt", deadline: "registrationDeadline",
  feeAmount: "feeAmount", feeNote: "feeNote", eligibility: "eligibility", rules: "rules", programme: "programme", guests: "guests", prizes: "prizes",
  contactName: "contactName", contactPhone: "contactPhone", contactEmail: "contactEmail", websiteUrl: "websiteUrl", link: "registrationUrl",
};
// Fields a poster may well not have: an empty one needs no "Check" badge.
const OPTIONAL = new Set(["tagline", "mapUrl", "endsAt", "deadline", "feeNote", "eligibility", "rules", "programme", "guests", "prizes", "websiteUrl", "link"]);
const BLANK_ITEM = { title: "", at: "", venue: "", fee: "", prize: "", note: "" };

export default function EventEditor({ ev, meta, warnings, autofilled, poster, clubs, isAdmin, reading, qrLinks = [], applyError = "" }) {
  const router = useRouter();
  const top = useRef(null);
  const [f, setF] = useState(() => ({
    title: ev.title || "", tagline: ev.tagline || "", category: ev.category || "", description: ev.description || "",
    clubId: ev.club_id || "", organizerName: ev.organizer_name || "", venue: ev.venue || "", mapUrl: ev.map_url || "",
    startsAt: toLocalInput(ev.starts_at), endsAt: toLocalInput(ev.ends_at), deadline: toLocalInput(ev.reg_closes_at),
    feeFree: ev.fee_amount != null && Number(ev.fee_amount) === 0, feeAmount: Number(ev.fee_amount) > 0 ? String(Number(ev.fee_amount)) : "", feeNote: ev.fee_note || "",
    eligibility: ev.eligibility || "", rules: ev.rules || "",
    programme: (ev.details?.programme || []).map((x) => ({ ...BLANK_ITEM, ...x, at: toLocalInput(x.at) })),
    guests: (ev.details?.guests || []).join("\n"), prizes: (ev.details?.prizes || []).join("\n"),
    contactName: ev.contact_name || "", contactPhone: ev.contact_phone || "", contactEmail: ev.contact_email || "", websiteUrl: ev.website_url || "", link: ev.link || "",
  }));
  const [touched, setTouched] = useState({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  // a club admin keeps their club in the list even if only the saved row names it
  const options = ev.club && !clubs.some((c) => c.id === ev.club.id) ? [...clubs, ev.club] : clubs;

  const change = (patch) => { setF((s) => ({ ...s, ...patch })); setTouched((t) => ({ ...t, ...Object.fromEntries(Object.keys(patch).map((k) => [k, true])) })); setDirty(true); setMsg(null); };
  const set = (key, value) => change({ [key]: value });
  const setItem = (n, key, value) => set("programme", f.programme.map((x, i) => (i === n ? { ...x, [key]: value } : x)));
  // Choosing a club fills the organiser with the club's name; a name that was typed is kept.
  const pickClub = (id) => change({ clubId: id, organizerName: organiserAfterClubChange(f.organizerName, options.find((c) => c.id === f.clubId) || null, options.find((c) => c.id === id) || null) });
  const flagged = (key) => {
    const m = autofilled && !touched[key] && META[key] ? meta?.[META[key]] : null;
    return Boolean(m?.needsReview) && !(OPTIONAL.has(key) && m.source === "missing");
  };

  // Plain functions (not components), so inputs keep their focus while typing.
  const badge = (key) => flagged(key)
    ? <span className="chk" title={[meta[META[key]].source !== "explicit" ? `Not stated directly on the poster (${meta[META[key]].source})` : "Please confirm", meta[META[key]].evidence ? `“${meta[META[key]].evidence}”` : ""].filter(Boolean).join(" · ")}><AlertTriangle size={12} /> Check</span>
    : null;
  const input = (key, label, props = {}) => (
    <div className="field"><label htmlFor={`ev-${key}`}>{label} {badge(key)}</label><input id={`ev-${key}`} type="text" value={f[key]} onChange={(e) => set(key, e.target.value)} {...props} /></div>
  );
  const area = (key, label, rows, max) => (
    <div className="field"><label htmlFor={`ev-${key}`}>{label} {badge(key)}</label><textarea id={`ev-${key}`} rows={rows} maxLength={max} value={f[key]} onChange={(e) => set(key, e.target.value)} /></div>
  );
  const itemInput = (n, key, label, props = {}) => (
    <div className="field"><label htmlFor={`ev-p${n}-${key}`}>{label}</label><input id={`ev-p${n}-${key}`} type="text" value={f.programme[n][key] || ""} onChange={(e) => setItem(n, key, e.target.value)} {...props} /></div>
  );

  const check = useMemo(() => validateEvent(f, { clubs: options, isAdmin }), [f, clubs, isAdmin]);   // eslint-disable-line react-hooks/exhaustive-deps
  const issues = check.ok ? publishIssues({ ...check.patch, details: check.details }) : null;

  const finish = (res, okText) => {
    setBusy(null);
    if (res?.error) { setMsg({ err: true, text: res.errors?.length > 1 ? res.errors.join(" ") : res.error }); top.current?.scrollIntoView({ behavior: "smooth", block: "start" }); return false; }
    setDirty(false); setMsg({ text: okText }); router.refresh(); return true;
  };
  const save = async () => { setBusy("save"); setMsg(null); return finish(await saveEvent({ id: ev.id, data: f }), ev.status === "published" ? "Changes saved. Students see them now." : "Saved."); };
  const setStatus = async (status, text, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(status); setMsg(null);
    const saved = dirty || status === "published" ? await saveEvent({ id: ev.id, data: f }) : { ok: true };
    if (saved.error) return finish(saved);
    finish(await setEventStatus({ id: ev.id, status }), text);
  };
  const refill = async () => {
    if ((dirty || autofilled) && !confirm("This replaces what is in the form with what the AI read from the poster. Continue?")) return;
    setBusy("refill"); setMsg(null);
    const res = await reapplyEventReading(ev.id);
    if (res?.error) { setBusy(null); setMsg({ err: true, text: res.error }); return; }
    setBusy(null); setDirty(false); setMsg({ text: "The form was filled in from the poster. Please check every value." }); router.refresh();
  };
  const remove = async () => {
    if (!confirm(`Remove "${ev.title}", its files and any RSVPs? This cannot be undone.`)) return;
    setBusy("remove");
    const r = await removeEvent(ev.id);
    if (r.error) return finish(r);
    router.push("/dashboard/events/manage");
  };

  const [statusLabel, statusColor] = STATUS[ev.status] || STATUS.draft;
  const dis = Boolean(busy);

  return (
    <div className="rv" ref={top}>
      <div className="page-head">
        <div><h1>{f.title || "New event"}</h1><p><span className="pill soft" style={{ "--c": statusColor }}>{statusLabel}</span></p></div>
      </div>

      {msg && <p className={`form-msg${msg.err ? " err" : ""}`} role={msg.err ? "alert" : "status"}>{msg.text}</p>}
      {autofilled && (
        <div className="form-msg">
          The AI filled in what it could read from the poster. <b>Please check every value against it</b>; anything marked <span className="chk"><AlertTriangle size={12} /> Check</span> was unclear or not stated.
          {warnings?.length > 0 && <ul className="warn">{warnings.map((x, i) => <li key={i}><AlertTriangle size={14} /> {x.message}</li>)}</ul>}
        </div>
      )}
      {reading?.status === "completed" && ev.status === "draft" && (
        <div className={`form-msg${!autofilled || applyError ? " err" : ""}`}>
          {applyError ? <>The AI read the poster, but some details could not be saved into this form. {applyError}</>
            : !autofilled ? <>The AI has read the poster, but the form was not filled in.</> : <>Form looks wrong or empty? You can fill it again from the AI reading.</>}
          {" "}<button type="button" className="btn-s" disabled={dis} onClick={refill}>{busy === "refill" ? "Filling…" : "Fill the form from the AI reading"}</button>
        </div>
      )}
      {reading?.status === "failed" && <div className="form-msg err">The AI could not read the poster: {reading.error} You can fill the details in by hand below.</div>}
      {reading && ["queued", "processing"].includes(reading.status) && <div className="form-msg">The poster is still being read. Come back in a minute and reload.</div>}

      <div className="rv-grid">
        <aside className="rv-pdf">
          <div className="rv-pdf-head">
            <b>{poster?.filename || "Poster"}</b>
            {poster?.url && <a className="btn-s" href={poster.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a>}
          </div>
          {poster?.url ? (poster.mime?.startsWith("image/") ? <img className="rv-img" src={poster.url} alt="The poster" /> : <iframe title="Event document" src={poster.url} />)
            : <div className="empty"><p>{poster ? "The file could not be loaded." : "No poster uploaded. You can fill the form in by hand."}</p></div>}
        </aside>

        <form className="rv-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <fieldset className="rv-fs" disabled={dis}>
            <section className="rv-card">
              <h2>The event</h2>
              {input("title", "Name", { maxLength: 140 })}
              {input("tagline", "Tagline or theme", { maxLength: 160 })}
              {area("description", "What is it about?", 4, 4000)}
              <div className="rv-two">
                <div className="field"><label htmlFor="ev-category">Kind of event {badge("category")}</label>
                  <select id="ev-category" value={f.category} onChange={(e) => set("category", e.target.value)}>
                    <option value="">Not chosen</option>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                <div className="field"><label htmlFor="ev-club">Organising club {badge("clubId")}</label>
                  <select id="ev-club" value={f.clubId} onChange={(e) => pickClub(e.target.value)}>
                    {(isAdmin || !f.clubId) && <option value="">{isAdmin ? "No club (college event)" : "Choose your club"}</option>}
                    {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select></div>
                {input("organizerName", "Organiser, as students should see it", { maxLength: 120, placeholder: "e.g. Student Council" })}
              </div>
            </section>

            <section className="rv-card">
              <h2>When and where <small>All times are India time</small></h2>
              <div className="rv-two">
                {input("startsAt", "Starts", { type: "datetime-local" })}
                {input("endsAt", "Ends", { type: "datetime-local" })}
                {input("venue", "Venue", { maxLength: 200, placeholder: "Auditorium, ground, hall" })}
                {input("mapUrl", "Map link", { placeholder: "https://maps..." })}
              </div>
              <p className="inline-msg">With no end time, the event counts as running for three hours.</p>
            </section>

            <section className="rv-card">
              <h2>Programme {badge("programme")} <small>Competitions, performances or sessions</small></h2>
              {!f.programme.length && <p className="inline-msg">Nothing listed. Add entries if the event has several parts.</p>}
              {f.programme.map((x, n) => (
                <fieldset key={n} className="field" style={{ border: "1.5px solid var(--line)", borderRadius: 12, padding: 12, margin: 0 }}>
                  <legend className="lab">Entry {n + 1}</legend>
                  <div className="rv-two">
                    {itemInput(n, "title", "Name", { maxLength: 120 })}
                    {itemInput(n, "at", "Time", { type: "datetime-local" })}
                    {itemInput(n, "venue", "Venue", { maxLength: 120 })}
                    {itemInput(n, "fee", "Fee", { maxLength: 80 })}
                    {itemInput(n, "prize", "Prize", { maxLength: 120 })}
                    {itemInput(n, "note", "Team size, rules or notes", { maxLength: 160 })}
                  </div>
                  <button type="button" className="btn-s ghost" onClick={() => set("programme", f.programme.filter((_, i) => i !== n))}><Trash2 size={14} /> Remove entry {n + 1}</button>
                </fieldset>
              ))}
              {f.programme.length < MAX_ITEMS && <div><button type="button" className="btn-s" onClick={() => set("programme", [...f.programme, { ...BLANK_ITEM }])}><Plus size={14} /> Add an entry</button></div>}
              {area("guests", "Guests, judges and performers (one per line)", 2)}
              {area("prizes", "Prizes and certificates (one per line)", 2)}
            </section>

            <section className="rv-card">
              <h2>Taking part</h2>
              <div className="rv-two">
                {input("deadline", "Last time to register", { type: "datetime-local" })}
                <div className="field"><span className="lab">Entry fee {badge("feeAmount")}</span>
                  <label className="chips-line"><input type="checkbox" checked={f.feeFree} onChange={(e) => set("feeFree", e.target.checked)} /> Free</label>
                  {!f.feeFree && <input type="text" inputMode="numeric" aria-label="Entry fee in rupees" value={f.feeAmount} placeholder="Rupees (empty if not stated)" onChange={(e) => set("feeAmount", e.target.value)} />}</div>
                {input("feeNote", "Fee note", { maxLength: 200 })}
                {input("link", "Registration link (if any)", { placeholder: "https://..." })}
              </div>
              {input("eligibility", "Who can take part (as written)", { maxLength: 300 })}
              {area("rules", "Rules, entry requirements or dress code", 3, 1500)}
              <p className="inline-msg">Every verified student sees the event and can mark Interested or Going. Only the counts are shown.</p>
            </section>

            <section className="rv-card">
              <h2>Contact and links</h2>
              {qrLinks.length > 0 && <p className="form-msg" role="status">The poster has a QR code. Open each link to check it is the right page: {qrLinks.map((u, i) => <span key={u}>{i ? ", " : ""}<a href={u} target="_blank" rel="noopener noreferrer">{u}</a></span>)}</p>}
              <div className="rv-two">
                {input("contactName", "Contact person", { maxLength: 80 })}
                {input("contactPhone", "Contact phone", { type: "tel", placeholder: "+91 98450 12345" })}
                {input("contactEmail", "Contact email", { type: "email" })}
                {input("websiteUrl", "Website", { placeholder: "https://..." })}
              </div>
            </section>
          </fieldset>

          <section className="rv-card" aria-label="Before you publish">
            <h2>Before you publish</h2>
            {!check.ok ? <ul className="warn">{check.errors.map((e, i) => <li key={i}><XCircle size={14} /> {e}</li>)}</ul> : (
              <>
                {issues.blocking.length > 0 && <ul className="warn">{issues.blocking.map((e, i) => <li key={i}><XCircle size={14} /> {e}</li>)}</ul>}
                {issues.hints.length > 0
                  ? <><p className="inline-msg">Students will ask about these. You can still publish:</p><ul className="warn">{issues.hints.map((e, i) => <li key={i}><AlertTriangle size={14} /> {e}</li>)}</ul></>
                  : issues.blocking.length === 0 && <p className="inline-msg">Everything students usually ask about is filled in.</p>}
              </>
            )}
          </section>

          <div className="rv-bar">
            <span className="inline-msg">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
            <button type="button" className="btn-s" disabled={dis || !dirty} onClick={save}>{busy === "save" ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} {ev.status === "published" ? "Save changes" : "Save"}</button>
            {ev.status !== "published" && <button type="button" className="btn" disabled={dis || !check.ok || issues?.blocking.length > 0} onClick={() => setStatus("published", "Published. Students can see it now.", "Publish this event now? Students will see it straight away.")}>{busy === "published" ? <LoaderCircle size={16} className="spin" /> : <Megaphone size={16} />} {ev.status === "cancelled" ? "Publish again" : "Publish now"}</button>}
            {ev.status === "published" && <button type="button" className="btn-s" disabled={dis} onClick={() => setStatus("draft", "It is a draft again. Students no longer see it.", "Take this event offline? Students will not see it until you publish it again.")}><Undo2 size={14} /> Unpublish</button>}
            {ev.status === "published" && <button type="button" className="btn-s" disabled={dis} onClick={() => setStatus("cancelled", "Marked as cancelled.", "Mark this event as cancelled? Students who marked Interested or Going are told, and reminders stop.")}><XCircle size={14} /> Cancel event</button>}
            {ev.status !== "published" && <button type="button" className="btn-s ghost" disabled={dis} onClick={remove}><Trash2 size={14} /> Delete</button>}
          </div>
        </form>
      </div>
    </div>
  );
}

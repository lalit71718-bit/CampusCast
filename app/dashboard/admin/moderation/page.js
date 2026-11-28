import { requireAdmin } from "../../../../lib/dash/ctx";
import { PendingNote, ReportRow, SuspendedMentor } from "../../../../components/dashboard/ModerationUI";

export const metadata = { title: "Moderation" };

export default async function Moderation() {
  const { supabase } = await requireAdmin();
  const [{ data: reports, error }, { data: pending }] = await Promise.all([
    supabase.rpc("report_queue"),
    supabase.from("notes").select("*").eq("status", "pending").order("created_at"),
  ]);
  const ids = [...new Set((pending || []).map((n) => n.uploader_id))];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id,full_name").in("id", ids) : { data: [] };
  const name = new Map((people || []).map((p) => [p.id, p.full_name]));
  // Mentors who were reported, and mentoring suspensions. Both stay empty before dashboard-15 has been run.
  const reported = (reports || []).filter((r) => r.kind === "user").map((r) => r.ref_id);
  const [{ data: mentors }, { data: suspended }] = await Promise.all([
    reported.length ? supabase.from("mentor_profiles").select("user_id").in("user_id", reported) : { data: [] },
    supabase.from("mentor_suspensions").select("user_id, reason").order("created_at", { ascending: false }),
  ]);
  const isMentor = new Set(suspended ? (mentors || []).map((m) => m.user_id) : []);
  const gone = (suspended || []).map((s) => s.user_id);
  const { data: goneNames } = gone.length ? await supabase.from("profiles").select("id,full_name").in("id", gone) : { data: [] };
  const goneName = new Map((goneNames || []).map((p) => [p.id, p.full_name]));
  return (
    <>
      <div className="page-head"><div><h1>Moderation</h1><p>{reports?.length || 0} open report{reports?.length === 1 ? "" : "s"} and {pending?.length || 0} upload{pending?.length === 1 ? "" : "s"} waiting for review. Every decision is written to the audit log.</p></div></div>
      {error && <p className="form-msg err">{error.message}</p>}
      <h2 style={{ fontFamily: "var(--font-d)" }}>Reports</h2>
      {!reports?.length ? <div className="empty"><h2>No open reports</h2><p>Reports from students show up here.</p></div> : <div className="feed">{reports.map((r) => <ReportRow key={r.id} r={r} isMentor={isMentor.has(r.ref_id)} />)}</div>}
      {!!suspended?.length && <>
        <h2 style={{ fontFamily: "var(--font-d)", marginTop: 28 }}>Suspended mentors</h2>
        <div className="feed">{suspended.map((s) => <SuspendedMentor key={s.user_id} row={s} name={goneName.get(s.user_id)} />)}</div>
      </>}
      <h2 style={{ fontFamily: "var(--font-d)", marginTop: 28 }}>Notes waiting for review</h2>
      {!pending?.length ? <div className="empty"><h2>Nothing to review</h2><p>New note and paper uploads appear here before they go live.</p></div> : <div className="feed">{pending.map((n) => <PendingNote key={n.id} n={n} uploader={name.get(n.uploader_id)} />)}</div>}
    </>
  );
}

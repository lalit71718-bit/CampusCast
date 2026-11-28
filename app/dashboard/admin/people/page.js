import { requireSuper } from "../../../../lib/dash/ctx";
import RoleRow from "../../../../components/dashboard/RoleRow";
import ExamAccessRow from "../../../../components/dashboard/ExamAccessRow";
import StudyYearRow from "../../../../components/dashboard/StudyYearRow";

export const metadata = { title: "People & roles" };

export default async function People({ searchParams }) {
  const sp = await searchParams;
  const q = String(sp.q || "").trim().replace(/[%,()]/g, "");
  const { supabase, user } = await requireSuper();
  let query = supabase.from("profiles").select("id,email,full_name,branch,year,status,role").order("role", { ascending: false }).order("full_name").limit(100);
  if (q) query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,usn.ilike.%${q}%`);
  const { data, error } = await query;

  // Exam notice access for everyone who is an admin (kept separate from the search above).
  const { data: depts } = await supabase.from("departments").select("name, code").eq("active", true).order("sort");
  const { data: staff, error: staffErr } = await supabase.from("profiles").select("id, email, full_name, admin_depts, approver_depts").eq("role", "admin").eq("status", "verified").order("full_name").limit(200);
  // Mentorship year: shown for the people matching the search.
  const { data: years, error: yearErr } = q && ids.length ? await supabase.rpc("study_years", { p_ids: ids.slice(0, 20) }) : { data: [] };
  const yearOf = new Map((years || []).map((y) => [y.id, y]));
  const students = (data || []).slice(0, 20).filter((p) => p.status === "verified" && p.person_type !== "faculty");
  return (
    <>
      <div className="page-head"><div><h1>People &amp; roles</h1><p>Only ID-verified students can be made admins. Every change is written to the audit log.</p></div></div>
      <form className="filters" role="search"><label className="sel"><span>Find</span><input name="q" defaultValue={q} placeholder="Name, email or USN" /></label><button className="chip">Search</button></form>
      {error && <p className="form-msg err">{error.message}</p>}
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Student</th><th>Branch</th><th>Status</th><th>Role</th></tr></thead>
          <tbody>{(data || []).map((p) => <RoleRow key={p.id} p={p} self={p.id === user.id} />)}</tbody>
        </table>
      </div>

      <h2 className="sub-h">Mentorship: year of study</h2>
      <p className="inline-msg">The year is read from the college email and moves up every 1 August. Only 4th years can mentor; 1st to 3rd years can ask for mentoring. Correct it only for lateral entry, a repeated year or an unusual email, after checking the ID card.</p>
      {yearErr ? <p className="form-msg err">{yearErr.message} (run supabase/dashboard-15-mentorship.sql in Supabase)</p>
        : !q || !students.length ? <div className="empty"><p>{q ? "No ID-verified student matches that search." : "Search for a student above to see or correct their year."}</p></div> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Student</th><th>Year now</th><th>Set year</th></tr></thead>
            <tbody>{students.map((p) => <StudyYearRow key={p.id} person={p} info={yearOf.get(p.id)} />)}</tbody>
          </table>
        </div>
      )}

      <h2 className="sub-h">Exam notice access</h2>
      <p className="inline-msg">Information staff upload and submit exam notices for the departments you tick under <b>Uploads for</b>. The head of a department (or a cluster head over several) approves and publishes for the departments under <b>Approves for</b>. A person who submitted a notice cannot approve it. Make someone an Admin above first.</p>
      {staffErr && <p className="form-msg err">{staffErr.message} (run supabase/dashboard-6-exams.sql in Supabase)</p>}
      {!staffErr && !(staff || []).length ? <div className="empty"><p>No admins yet. Change a verified student's role to Admin above, then come back here.</p></div> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Staff</th><th>Departments</th><th /></tr></thead>
            <tbody>{(staff || []).map((s) => <ExamAccessRow key={s.id} person={s} departments={depts || []} />)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

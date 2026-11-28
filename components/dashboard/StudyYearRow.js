"use client";
import { setStudyYear } from "../../app/dashboard/community-actions";
import { useAct } from "./Common";

// One student on the People page: the year mentorship uses, and a correction for it.
export default function StudyYearRow({ person, info }) {
  const { msg, pending, act } = useAct();
  const year = info?.study_year;
  return (
    <tr>
      <td>{person.full_name || person.email}<br /><small>{person.email}</small></td>
      <td>{!year ? "Not known" : year > 4 ? "Past 4th year" : `Year ${year}`}{info?.corrected ? " (corrected)" : ""}</td>
      <td>
        <select aria-label={`Set year for ${person.full_name || person.email}`} disabled={pending} value={info?.corrected && year ? String(Math.min(year, 5)) : ""}
          onChange={(e) => act(() => setStudyYear(person.id, e.target.value))}>
          <option value="">From college email</option>
          {[1, 2, 3, 4].map((y) => <option key={y} value={y}>Year {y}</option>)}
          <option value="5">Past 4th year</option>
        </select>
        {msg && <span className="inline-msg" role="alert">{msg}</span>}
      </td>
    </tr>
  );
}

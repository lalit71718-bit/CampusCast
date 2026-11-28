// Where an event is right now, and what to count down to. Pure (the time is passed in), so it can be tested.
// Rows saved before dashboard-13 have no status: they count as published.

const H = 3600e3;
const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isNaN(t) ? null : t; };
const phase = (key, label, color, target = null, over = false) => ({ key, label, color, target, over });

/** When the event is over: its end, or three hours after the start when no end is given (the database uses the same). */
export const eventEndMs = (e) => ms(e.ends_at) ?? (ms(e.starts_at) === null ? null : ms(e.starts_at) + 3 * H);

export function eventPhase(e, nowMs = Date.now()) {
  const starts = ms(e.starts_at), ends = ms(e.ends_at), closes = ms(e.reg_closes_at), finish = eventEndMs(e);
  if (e.status === "cancelled") return phase("cancelled", "Cancelled", "#e8603c", null, finish !== null && nowMs >= finish);
  if (e.status === "draft") return phase("draft", "Draft", "#d9c8a8");
  if (finish !== null && nowMs >= finish) return phase("ended", "Ended", "#d9c8a8", null, true);
  // Registration that is still open during a fest is counted down first; otherwise the end, if one is given.
  if (starts !== null && nowMs >= starts) {
    const target = closes !== null && nowMs < closes ? { at: closes, label: "Registration closes in" } : ends !== null ? { at: ends, label: "Ends in" } : null;
    return phase("live", "Happening now", "#2f7a4a", target);
  }
  const startTarget = starts !== null ? { at: starts, label: "Starts in" } : null;
  if (closes !== null && nowMs >= closes) return phase("closed", "Registration closed", "#d9c8a8", startTarget);
  if (closes !== null) {
    const soon = closes - nowMs < 48 * H;
    return phase(soon ? "closing" : "open", soon ? "Closing soon" : "Registration open", soon ? "#f3b63f" : "#7fb48a", { at: closes, label: "Registration closes in" });
  }
  const soon = starts !== null && starts - nowMs < 48 * H;
  return phase(soon ? "closing" : "open", soon ? "Starting soon" : "Coming up", soon ? "#f3b63f" : "#c58ad1", startTarget);
}

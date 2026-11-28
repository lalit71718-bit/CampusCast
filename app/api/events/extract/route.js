import { after } from "next/server";
import { createClient, getUser } from "../../../../lib/supabase/server";
import { aiConfig } from "../../../../lib/exams/config";
import { runEventExtraction } from "../../../../lib/events/process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;   // reading a poster can take a minute or more

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// Starts reading one queued event poster. Answers at once (202); the work continues after the response, and the
// browser follows its progress by watching the event_extractions row.
export async function POST(req) {
  const supabase = await createClient();
  const user = await getUser();
  if (!supabase || !user) return json({ error: "Please sign in." }, 401);

  // Only people who may post events (admins and club admins).
  const { data: allowed } = await supabase.rpc("can_publish_events");
  if (allowed !== true) return json({ error: "Not allowed." }, 403);

  const body = await req.json().catch(() => null);
  const extractionId = body?.extractionId;
  if (!UUID.test(String(extractionId))) return json({ error: "Invalid request." }, 400);

  // Row-level security decides whether this person can see (and so run) it.
  const { data: row } = await supabase.from("event_extractions").select("id, status").eq("id", extractionId).maybeSingle();
  if (!row) return json({ error: "Not found." }, 404);
  if (row.status !== "queued") return json({ status: row.status }, 200);

  const { providers } = aiConfig();
  if (!providers.length) {
    await supabase.from("event_extractions").update({
      status: "failed", finished_at: new Date().toISOString(),
      error: "AI reading isn't set up on this server yet (add GEMINI_API_KEY or GROQ_API_KEY). You can still fill the details in by hand.",
      field_meta: { _failure: { code: "not_configured", retryable: true } },
    }).eq("id", extractionId);
    return json({ status: "failed", error: "not_configured" }, 503);
  }

  after(() => runEventExtraction({ supabase, extractionId, providers }));
  return json({ status: "queued" }, 202);
}

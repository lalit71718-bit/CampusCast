// Posters added with the older "Add event" form sit in the private event-media bucket, named in events.poster.
// Returns Map<event id, short-lived link>. (Posters uploaded for AI reading are served by /api/events/file/<id>.)
export async function legacyPosters(supabase, events) {
  const out = new Map();
  await Promise.all((events || []).filter((e) => e.poster?.path).map(async (e) => {
    const { data } = await supabase.storage.from("event-media").createSignedUrl(e.poster.path, 3600);
    if (data?.signedUrl) out.set(e.id, data.signedUrl);
  }));
  return out;
}

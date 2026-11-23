import { chatFeedback } from "@/lib/public/chat";
import { corsFor, json, preflight } from "@/lib/public/cors";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Thumbs up or down on an answer. */
export async function POST(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  const r = await chatFeedback(await req.json().catch(() => null));
  return r.ok ? json({ ok: true }, 200, cors) : json({ error: r.error }, r.status, cors);
}

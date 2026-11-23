import { log } from "@/lib/logger";
import { clientIp } from "@/lib/request";
import { corsFor, json, preflight, selfOrigin } from "@/lib/public/cors";
import { submitPublicTicket } from "@/lib/public/submission";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** The support form's submission. */
export async function POST(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  const body = await req.json().catch(() => null);
  try {
    const result = await submitPublicTicket(body, { ip: await clientIp(), origin: selfOrigin(req) });
    if (!result.ok) return json({ error: result.error, fields: result.fields }, result.status, cors);
    return json({ reference: result.reference, attached: result.attached }, 201, cors);
  } catch (err) {
    log.error("Public ticket submission failed", { err });
    return json({ error: "Something went wrong on our side. Please try again in a minute." }, 500, cors);
  }
}

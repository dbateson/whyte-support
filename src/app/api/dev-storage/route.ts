import { readLocalObject, verifyLocal, writeLocalObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Local-disk stand-in for object storage, for development only. Links are
 * signed and short-lived, like Supabase's. Off in production unless
 * WHYTE_LOCAL_STORAGE=1 (used by the end-to-end tests).
 */
const enabled = () => process.env.NODE_ENV !== "production" || process.env.WHYTE_LOCAL_STORAGE === "1";
const MAX = 25 * 1024 * 1024;

function params(req: Request) {
  const u = new URL(req.url);
  return { key: u.searchParams.get("key") ?? "", expires: Number(u.searchParams.get("expires")), sig: u.searchParams.get("sig") ?? "", name: u.searchParams.get("name") ?? "file" };
}

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT, GET, OPTIONS", "access-control-allow-headers": "content-type, x-upsert" };

export function OPTIONS() {
  return enabled() ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 404 });
}

export async function PUT(req: Request) {
  if (!enabled()) return new Response(null, { status: 404 });
  const { key, expires, sig } = params(req);
  if (!verifyLocal("put", key, expires, sig)) return new Response("Bad signature", { status: 403, headers: cors });
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > MAX) return new Response("Too large", { status: 413, headers: cors });
  try {
    await writeLocalObject(key, body, req.headers.get("content-type") ?? "application/octet-stream");
  } catch {
    return new Response("Already exists", { status: 409, headers: cors });
  }
  return Response.json({ Key: key }, { headers: cors });
}

export async function GET(req: Request) {
  if (!enabled()) return new Response(null, { status: 404 });
  const { key, expires, sig, name } = params(req);
  if (!verifyLocal("get", key, expires, sig)) return new Response("Bad signature", { status: 403 });
  try {
    const { body, contentType } = await readLocalObject(key);
    return new Response(new Uint8Array(body), { headers: { "content-type": contentType, "content-disposition": `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"` } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

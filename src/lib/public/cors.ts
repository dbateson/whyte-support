import "server-only";
import { getSettings } from "../settings";

/**
 * Which browser origins may call the public API: this site, the configured
 * embed origins (whytebikes.com) and the shop's myshopify.com domain.
 */
export async function allowedOrigins(selfOrigin: string): Promise<Set<string>> {
  const s = await getSettings(["embed.allowed_origins", "shopify.shop_domain"]);
  const list = s["embed.allowed_origins"].split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  if (s["shopify.shop_domain"]) list.push(`https://${s["shopify.shop_domain"]}`);
  return new Set([selfOrigin, ...list]);
}

export function selfOrigin(req: Request): string {
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** The CORS headers for a request, or null when its origin isn't allowed. Requests with no Origin (not from a browser) pass. */
export async function corsFor(req: Request): Promise<Record<string, string> | null> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = await allowedOrigins(selfOrigin(req));
  if (!allowed.has(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export async function preflight(req: Request): Promise<Response> {
  const headers = await corsFor(req);
  return headers ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...headers, "cache-control": "no-store" } });
}

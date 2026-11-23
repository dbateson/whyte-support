import "server-only";
import { headers } from "next/headers";
import { getSetting } from "./settings";

/** The client's address, as Vercel's proxy reports it. Used only hashed, for rate limits. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/**
 * Where links in emails should point: the configured public URL. In
 * production, never the request's own Host header (a forged one could put an
 * attacker's address in a password-reset email); Vercel's production domain
 * is the fallback until the setting is filled in.
 */
export async function baseUrl(): Promise<string> {
  const configured = await getSetting("app.public_url");
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

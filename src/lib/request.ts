import "server-only";
import { headers } from "next/headers";
import { getSetting } from "./settings";

/** The client's address, as Vercel's proxy reports it. Used only hashed, for rate limits. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Where links in emails should point: the configured public URL, else this request's origin. */
export async function baseUrl(): Promise<string> {
  const configured = await getSetting("app.public_url");
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

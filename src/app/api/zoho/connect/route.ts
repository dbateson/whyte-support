import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth/session";
import { baseUrl } from "@/lib/request";
import { getSecret } from "@/lib/secrets";
import { getSettings } from "@/lib/settings";
import { ZOHO_SCOPES } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

/** Sends an admin to Zoho's consent screen. The state value guards the return trip. */
export async function GET() {
  await requireStaff("settings.manage");
  const clientId = await getSecret("zoho.client_id");
  if (!clientId) return NextResponse.redirect(new URL("/admin/settings/zoho?error=client", await baseUrl()));
  const { "zoho.accounts_domain": accounts } = await getSettings(["zoho.accounts_domain"]);
  const state = randomBytes(24).toString("base64url");
  (await cookies()).set("zoho_oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/zoho/callback", maxAge: 600 });
  const url = new URL(`${accounts.replace(/\/$/, "")}/oauth/v2/auth`);
  url.search = new URLSearchParams({
    scope: ZOHO_SCOPES.join(","),
    client_id: clientId,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    redirect_uri: `${await baseUrl()}/api/zoho/callback`,
    state,
  }).toString();
  return NextResponse.redirect(url);
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth/session";
import { safeEqual } from "@/lib/email/addresses";
import { baseUrl } from "@/lib/request";
import { setSecret } from "@/lib/secrets";
import { exchangeCode } from "@/lib/zoho/client";
import { logSync } from "@/lib/zoho/state";

export const dynamic = "force-dynamic";

/** Zoho sends the admin back here with a one-time code, swapped for a refresh token (stored encrypted). */
export async function GET(req: Request) {
  const staff = await requireStaff("settings.manage");
  const base = await baseUrl();
  const back = (q: string) => NextResponse.redirect(new URL(`/admin/settings/zoho?${q}`, base));
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const expected = jar.get("zoho_oauth_state")?.value;
  jar.delete({ name: "zoho_oauth_state", path: "/api/zoho/callback" });
  const state = params.get("state") ?? "";
  if (!expected || !state || !safeEqual(state, expected)) return back("error=state");
  if (params.get("error")) return back("error=denied");
  const code = params.get("code");
  if (!code) return back("error=code");
  try {
    const { refreshToken } = await exchangeCode(code, `${base}/api/zoho/callback`);
    await setSecret("zoho.refresh_token", refreshToken, { id: staff.id, label: staff.name });
    await logSync({ direction: "out", entity: "connection", message: `Connected to Zoho by ${staff.name}.` });
    return back("connected=1");
  } catch {
    return back("error=exchange");
  }
}

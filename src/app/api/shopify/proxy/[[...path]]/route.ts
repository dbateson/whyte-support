import { customerTokenKey } from "@/lib/public/submission";
import { selfOrigin } from "@/lib/public/cors";
import { getSecret } from "@/lib/secrets";
import { getSettings } from "@/lib/settings";
import { issueCustomerToken, proxyTimestampFresh, verifyProxySignature } from "@/lib/shopify/proxy";

export const dynamic = "force-dynamic";

const escapeAttr = (s: string) => s.replace(/[&"<>']/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;", "'": "&#39;" })[c]!);
/** A value safe inside a Liquid single-quoted string. */
const liquidString = (s: string) => s.replace(/[^A-Za-z0-9 _-]/g, "");

/**
 * Shopify App Proxy: whytebikes.com/apps/support → here. We answer with
 * Liquid, so Shopify renders the form inside the store's own theme (header,
 * footer, fonts). A signed-in customer gets a short-lived token proving who
 * they are; the form sends it back, and the server checks for a dealer tag.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const secret = await getSecret("shopify.api_secret");
  if (!secret) return new Response("The Shopify app isn't set up", { status: 503 });
  if (!verifyProxySignature(params, secret) || !proxyTimestampFresh(params)) return new Response("Forbidden", { status: 403 });

  // whytebikes.com/apps/support/identity: who is signed in, for the chat on any store page.
  if (new URL(req.url).pathname.replace(/\/$/, "").endsWith("/identity")) {
    const id = params.get("logged_in_customer_id") ?? "";
    const t = /^\d{1,20}$/.test(id) ? issueCustomerToken(id, customerTokenKey()) : null;
    return Response.json({ token: t }, { headers: { "cache-control": "private, no-store" } });
  }

  const s = await getSettings(["shopify.b2b_tag"]);
  const origin = selfOrigin(req);
  const customerId = params.get("logged_in_customer_id") ?? "";
  const token = /^\d{1,20}$/.test(customerId) ? issueCustomerToken(customerId, customerTokenKey()) : "";
  const tag = liquidString(s["shopify.b2b_tag"]);

  const liquid = `<div class="page-width">
  <h1>How can we help?</h1>
  <p>Tell us what's going on and we'll reply by email. Warranty claims, technical questions, orders and dealer enquiries all start here.</p>
  <script src="${escapeAttr(origin)}/embed/support-form.js" defer></script>
  <whyte-support-form api-base="${escapeAttr(origin)}"${token ? ` shopify-token="${escapeAttr(token)}"` : ""}{% if customer %} name="{{ customer.name | escape }}" email="{{ customer.email | escape }}"{% if customer.tags contains '${tag}' %} segment="b2b"{% endif %}{% endif %}></whyte-support-form>
</div>`;
  return new Response(liquid, { headers: { "content-type": "application/liquid; charset=utf-8", "cache-control": "no-store" } });
}

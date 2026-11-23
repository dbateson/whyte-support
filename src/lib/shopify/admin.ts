import "server-only";
import { log } from "../logger";
import { getSecret } from "../secrets";
import { getSettings } from "../settings";

/** The Admin API version this code is written against (Shopify supports each for a year). */
export const SHOPIFY_API_VERSION = "2026-10";

export interface ShopifyCustomer {
  id: string;
  email: string | null;
  name: string;
  phone: string | null;
  tags: string[];
  company: string | null;
  isDealer: boolean;
}

/** Looks up a customer by id, to fill in the form and decide B2B. Null if Shopify isn't set up or it fails. */
export async function fetchShopifyCustomer(customerId: string): Promise<ShopifyCustomer | null> {
  const token = await getSecret("shopify.admin_token");
  const s = await getSettings(["shopify.shop_domain", "shopify.b2b_tag"]);
  if (!token || !s["shopify.shop_domain"]) return null;
  const query = `query($id: ID!) { customer(id: $id) { email firstName lastName phone tags defaultAddress { company } } }`;
  try {
    const res = await fetch(`https://${s["shopify.shop_domain"]}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables: { id: `gid://shopify/Customer/${customerId}` } }),
    });
    if (!res.ok) {
      log.warn("Shopify customer lookup failed", { status: res.status });
      return null;
    }
    const body = (await res.json()) as {
      data?: { customer?: { email?: string; firstName?: string; lastName?: string; phone?: string; tags?: string[]; defaultAddress?: { company?: string } } | null };
    };
    const c = body.data?.customer;
    if (!c) return null;
    const tags = c.tags ?? [];
    const dealerTag = s["shopify.b2b_tag"].trim().toLowerCase();
    return {
      id: customerId,
      email: c.email ?? null,
      name: [c.firstName, c.lastName].filter(Boolean).join(" "),
      phone: c.phone ?? null,
      tags,
      company: c.defaultAddress?.company ?? null,
      isDealer: dealerTag !== "" && tags.some((t) => t.trim().toLowerCase() === dealerTag),
    };
  } catch (err) {
    log.error("Shopify customer lookup failed", { err });
    return null;
  }
}

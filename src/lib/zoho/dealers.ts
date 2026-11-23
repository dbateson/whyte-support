import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import { PUBLIC_EMAIL_DOMAINS } from "./mapping";

/**
 * Finds the Zoho dealer account a person belongs to, from the account number
 * they gave or their email's domain (never a public one like gmail.com).
 * Accounts are mirrored from Zoho, so this costs no API call.
 */
export async function matchDealerAccount(tx: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], input: { accountCode?: string | null; email?: string | null }) {
  const code = input.accountCode?.trim();
  if (code) {
    const [byCode] = await tx
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(and(sql`lower(${schema.accounts.accountNumber}) = lower(${code})`, eq(schema.accounts.isDealer, true)))
      .limit(1);
    if (byCode) return { ...byCode, by: "account number" as const };
  }
  const domain = input.email?.split("@")[1]?.toLowerCase();
  if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) {
    const [byDomain] = await tx
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.emailDomain, domain), eq(schema.accounts.isDealer, true)))
      .limit(1);
    if (byDomain) return { ...byDomain, by: "email domain" as const };
  }
  return null;
}

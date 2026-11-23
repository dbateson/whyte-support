import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "../env";
import { log } from "../logger";
import { allow } from "../rate-limit";
import { readCustomerToken } from "../shopify/proxy";
import { fetchShopifyCustomer } from "../shopify/admin";
import { attachUploads, ATTACHMENT_LIMITS } from "../storage/attachments";
import { CATEGORIES } from "../tickets/format";
import { createTicketWithMessage } from "../tickets/service";
import { verifyTurnstile } from "../turnstile";
import { sendAcknowledgement } from "../email/acknowledgement";

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) => text(max).optional().transform((v) => (v ? v : null));

export const submissionSchema = z.object({
  segment: z.enum(["b2c", "b2b"]),
  category: z.enum(CATEGORIES),
  name: text(120).min(1, "Enter your name."),
  email: z.string().trim().toLowerCase().email("Enter an email address we can reply to.").max(200),
  phone: optional(40),
  company: optional(160),
  accountCode: optional(40),
  summary: text(200).min(3, "Give your request a short summary."),
  details: text(10000).min(10, "Tell us a little more: what happened, and when?"),
  productModel: optional(120),
  frameNumber: optional(60),
  purchaseDate: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v) <= new Date()), "The purchase date can't be in the future."),
  purchasedFrom: optional(160),
  orderNumber: optional(60),
  attachments: z.array(z.string().uuid()).max(ATTACHMENT_LIMITS.maxFiles).default([]),
  claimKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  turnstileToken: z.string().max(4000).optional(),
  shopifyToken: z.string().max(1000).optional(),
  /** Honeypot: hidden from people, filled in by bots. */
  website: z.string().max(0).optional(),
}).superRefine((v, ctx) => {
  if (v.segment === "b2b" && !v.company) ctx.addIssue({ code: "custom", path: ["company"], message: "Enter your business name." });
});

export type Submission = z.input<typeof submissionSchema>;

export type SubmitResult =
  | { ok: true; reference: string; attached: number }
  | { ok: false; status: number; error: string; fields?: Record<string, string> };

function customerTokenKey(): Buffer {
  return createHash("sha256").update(Buffer.concat([Buffer.from("shopify-customer-token:"), Buffer.from(env().APP_ENCRYPTION_KEY, "base64")])).digest();
}
export { customerTokenKey };

/** Validates, checks for abuse, creates the ticket, attaches uploads and sends the acknowledgement. */
export async function submitPublicTicket(raw: unknown, ctx: { ip: string; origin: string }): Promise<SubmitResult> {
  const parsed = submissionSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      if (key === "website") return { ok: true, reference: "WS-0", attached: 0 }; // a bot: pretend it worked
      fields[key] ??= issue.message;
    }
    return { ok: false, status: 400, error: "Please check the highlighted fields.", fields };
  }
  const f = parsed.data;

  if (!(await allow("submit-ip", ctx.ip, 8, 60 * 60 * 1000)) || !(await allow("submit-email", f.email, 10, 24 * 60 * 60 * 1000))) {
    return { ok: false, status: 429, error: "We've had a lot of requests from you just now. Please try again in an hour, or call us." };
  }
  const turnstile = await verifyTurnstile(f.turnstileToken, ctx.ip);
  if (turnstile === "failed") return { ok: false, status: 400, error: "We couldn't confirm you're not a robot. Please try again." };
  if (turnstile === "not-configured" && process.env.NODE_ENV === "production") {
    // Without the robot check, a much tighter limit per connection.
    log.warn("Turnstile isn't set up: the public form is protected by rate limits only");
    if (!(await allow("submit-ip-unchecked", ctx.ip, 3, 60 * 60 * 1000))) return { ok: false, status: 429, error: "Too many requests from your connection. Please try again later." };
  }

  // A signed-in Shopify customer (via the App Proxy page) is verified; everyone else is as they say.
  let segment = f.segment;
  let shopifyCustomerId: string | null = null;
  const cid = readCustomerToken(f.shopifyToken, customerTokenKey());
  if (cid) {
    shopifyCustomerId = cid;
    const customer = await fetchShopifyCustomer(cid);
    if (customer?.isDealer) segment = "b2b";
  }

  const { ticket, message } = await createTicketWithMessage(
    {
      segment,
      subject: f.summary,
      body: f.details,
      source: "form",
      category: f.category,
      contact: { email: f.email, name: f.name, phone: f.phone, companyName: f.company, accountCode: f.accountCode, shopifyCustomerId },
      productModel: f.productModel,
      frameNumber: f.frameNumber,
      purchaseDate: f.purchaseDate,
      purchasedFrom: f.purchasedFrom,
      orderNumber: f.orderNumber,
      firstMessageFrom: "customer",
      channel: "web",
    },
    { label: "Support form" },
  );
  const attached = await attachUploads(f.attachments, f.claimKey, ticket.id, message.id, ctx.origin);
  await sendAcknowledgement(ticket, { name: f.name, email: f.email }, attached.length);
  return { ok: true, reference: `WS-${ticket.number}`, attached: attached.length };
}

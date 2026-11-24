import "server-only";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { TicketPriority, TicketStatus } from "../db/schema";
import { enqueueTicket } from "../ingest/pipeline";
import { log } from "../logger";
import { getSettings } from "../settings";
import { ref } from "../tickets/format";
import { zoho } from "./client";
import { ACCOUNT_FIELDS, CASE_FIELDS, CASE_READ_FIELDS, CONTACT_FIELDS, domainOf, hashFields, ownedCaseFields, priorityKeys, reverseMap, statusKeys } from "./mapping";
import { asZoho } from "./push";
import { logSync, readState, writeState } from "./state";

/**
 * Brings Zoho's changes in. Zoho owns accounts and contact details, so those
 * are applied. A ticket's subject, status and priority belong to this app: a
 * change made to them in Zoho is noted on the ticket and put back. New cases
 * made in Zoho become tickets, and notes added in Zoho become internal notes.
 * Everything is applied with app.sync_origin = 'zoho', so none of it is sent back.
 */

type Lookup = { id: string; name?: string } | null;
interface ZAccount { id: string; Account_Name?: string; Account_Number?: string | null; Account_Type?: string | null; Website?: string | null; Phone?: string | null; Modified_Time?: string }
interface ZContact { id?: string; First_Name?: string | null; Last_Name?: string | null; Email?: string | null; Phone?: string | null; Mobile?: string | null; Account_Name?: Lookup; Modified_Time?: string }
interface ZCase { id: string; Subject?: string; Status?: string; Priority?: string | null; Description?: string | null; Solution?: string | null; Email?: string | null; Phone?: string | null; Related_To?: Lookup; Account_Name?: Lookup; Case_Number?: string; Created_Time?: string; Modified_Time?: string }
interface ZNote { id: string; Note_Title?: string | null; Note_Content?: string | null; Created_Time?: string; Created_By?: { name?: string } | null }

export const MODULES = { Accounts: ACCOUNT_FIELDS, Contacts: CONTACT_FIELDS, Cases: CASE_READ_FIELDS } as const;
export type Module = keyof typeof MODULES;

/* ---------- Accounts ---------- */

async function dealerTypes(): Promise<string[]> {
  return (await getSettings(["zoho.dealer_account_types"]))["zoho.dealer_account_types"]
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export async function applyAccount(a: ZAccount, types?: string[]): Promise<string> {
  const dealerTypesList = types ?? (await dealerTypes());
  const values = {
    name: a.Account_Name ?? "",
    accountNumber: a.Account_Number?.trim() || null,
    accountType: a.Account_Type ?? null,
    website: a.Website ?? null,
    emailDomain: domainOf(a.Website),
    phone: a.Phone ?? null,
    isDealer: dealerTypesList.length === 0 || dealerTypesList.includes((a.Account_Type ?? "").toLowerCase()),
    zohoModifiedAt: a.Modified_Time ? new Date(a.Modified_Time) : null,
    updatedAt: new Date(),
  };
  const [row] = await db()
    .insert(schema.accounts)
    .values({ zohoAccountId: a.id, ...values })
    .onConflictDoUpdate({ target: schema.accounts.zohoAccountId, set: values })
    .returning({ id: schema.accounts.id });
  return row!.id;
}

/** The local account for a Zoho account id, fetching it from Zoho if it isn't here yet. */
async function localAccount(zohoAccountId: string | undefined): Promise<typeof schema.accounts.$inferSelect | null> {
  if (!zohoAccountId) return null;
  const [have] = await db().select().from(schema.accounts).where(eq(schema.accounts.zohoAccountId, zohoAccountId));
  if (have) return have;
  const res = await zoho<{ data: ZAccount[] }>("GET", `/Accounts/${zohoAccountId}`, { query: { fields: ACCOUNT_FIELDS.join(",") } });
  const a = res?.data?.[0];
  if (!a) return null;
  await applyAccount(a);
  const [made] = await db().select().from(schema.accounts).where(eq(schema.accounts.zohoAccountId, zohoAccountId));
  return made ?? null;
}

/* ---------- Contacts ---------- */

const fullName = (c: ZContact) => [c.First_Name, c.Last_Name].filter(Boolean).join(" ").trim();

/**
 * Zoho's contact details win for contacts this app already knows (linked, or
 * with the same email). Zoho contacts with no tickets here aren't copied in:
 * no reason to hold their personal data.
 */
export async function applyContact(c: ZContact, opts: { create?: boolean } = {}): Promise<string | null> {
  const email = c.Email?.trim().toLowerCase() || null;
  let [local] = c.id ? await db().select().from(schema.contacts).where(eq(schema.contacts.zohoContactId, c.id)) : [];
  if (!local && email) [local] = await db().select().from(schema.contacts).where(eq(schema.contacts.email, email));
  if (local?.anonymisedAt) return local.id; // erased on request: never refilled
  if (!local && !opts.create) return null;
  const account = await localAccount(c.Account_Name?.id);
  const patch = {
    ...(c.id ? { zohoContactId: c.id } : {}),
    name: fullName(c) || local?.name || "",
    phone: c.Phone || c.Mobile || local?.phone || null,
    ...(email ? { email } : {}),
    accountId: account?.id ?? null,
    ...(account?.isDealer ? { segment: "b2b" as const, companyName: account.name } : {}),
    updatedAt: new Date(),
  };
  return asZoho(async (tx) => {
    if (local) {
      // The email may belong to another local contact already: keep ours rather than fail.
      if (email && email !== local.email) {
        const [clash] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.email, email));
        if (clash) delete (patch as { email?: string }).email;
      }
      await tx.update(schema.contacts).set(patch).where(eq(schema.contacts.id, local.id));
      return local.id;
    }
    const [made] = await tx.insert(schema.contacts).values({ segment: "b2c", ...patch }).returning({ id: schema.contacts.id });
    return made!.id;
  });
}

/* ---------- Cases ---------- */

async function caseMaps() {
  const s = await getSettings(["zoho.status_map", "zoho.priority_map"]);
  return { status: s["zoho.status_map"], priority: s["zoho.priority_map"], toStatus: reverseMap<TicketStatus>(s["zoho.status_map"], statusKeys), toPriority: reverseMap<TicketPriority>(s["zoho.priority_map"], priorityKeys) };
}

/** Applies one Zoho case. Returns what happened, for the log. */
export interface CaseOptions {
  withNotes?: boolean;
  history?: boolean;
  /** Queue closed cases for knowledge-base drafting (on unless the history import was started without it). */
  feedKb?: boolean;
}

export async function applyCase(c: ZCase, opts: CaseOptions = {}): Promise<"created" | "unchanged" | "conflict" | "linked"> {
  const maps = await caseMaps();
  const [ticket] = await db().select().from(schema.tickets).where(eq(schema.tickets.zohoCaseId, c.id));
  if (!ticket) {
    await createTicketFromCase(c, maps, opts);
    return "created";
  }

  // What Zoho has for the fields this app owns, in the shape this app sends them.
  const incoming = {
    [CASE_FIELDS.subject]: (c.Subject ?? "").slice(0, 255),
    [CASE_FIELDS.status]: c.Status ?? "",
    [CASE_FIELDS.priority]: c.Priority ?? "",
    ...(c.Related_To?.id ? { [CASE_FIELDS.contact]: { id: c.Related_To.id } } : {}),
    ...(c.Account_Name?.id ? { [CASE_FIELDS.account]: { id: c.Account_Name.id } } : {}),
  };
  let result: "unchanged" | "conflict" = "unchanged";
  if (hashFields(incoming) !== ticket.zohoHash) {
    // Ours to own: note what Zoho changed, and queue the ticket so Zoho is put back in step.
    const ours = ownedCaseFields(ticket, maps);
    const changed = (Object.keys(ours) as (keyof typeof ours)[]).filter((k) => ours[k] !== incoming[k]);
    if (changed.length) {
      result = "conflict";
      await db().transaction(async (tx) => {
        // Record what Zoho now holds, so the next push sees the difference and puts it back.
        await tx.update(schema.tickets).set({ zohoHash: hashFields(incoming) }).where(eq(schema.tickets.id, ticket.id));
        await tx.insert(schema.ticketEvents).values({
          ticketId: ticket.id,
          actorLabel: "Zoho CRM",
          type: "zoho",
          fromValue: changed.map((k) => `${k}: ${ours[k]}`).join("; "),
          toValue: changed.map((k) => `${k}: ${incoming[k] || "(blank)"}`).join("; "),
        });
        await tx
          .insert(schema.syncOutbox)
          .values({ entity: "ticket", entityId: ticket.id })
          .onConflictDoUpdate({ target: [schema.syncOutbox.entity, schema.syncOutbox.entityId], set: { changedAt: sql`now()`, nextAttemptAt: sql`now()`, attempts: 0 } });
      });
      await logSync({ direction: "in", entity: "ticket", entityId: ticket.id, zohoId: c.id, level: "warning", message: `${ref(ticket.number)}: ${changed.join(", ")} changed in Zoho; this app manages them, so Zoho will be put back.` });
    }
  }
  if (c.Case_Number && c.Case_Number !== ticket.zohoCaseNumber) await asZoho((tx) => tx.update(schema.tickets).set({ zohoCaseNumber: c.Case_Number }).where(eq(schema.tickets.id, ticket.id)));
  const solutionChanged = await syncSolution(ticket.id, c);
  const notesAdded = opts.withNotes ? await pullNotes(c.id, ticket.id) : 0;
  // A Zoho case that's closed here, whose answer just arrived or changed, goes to the knowledge base.
  if ((solutionChanged || notesAdded) && ticket.source === "zoho" && (ticket.status === "resolved" || ticket.status === "closed") && opts.feedKb !== false) await feedKb(ticket.id);
  return result;
}

/**
 * Zoho's Solution field is the answer Whyte gave on the case: kept as a
 * Whyte reply on the ticket (one per case, updated when it changes), so it
 * reads in the thread and feeds the knowledge base. Returns whether it changed.
 */
async function syncSolution(ticketId: string, c: ZCase): Promise<boolean> {
  const text = c.Solution?.trim();
  if (!text) return false;
  const key = `solution:${c.id}`;
  const [have] = await db().select({ id: schema.ticketMessages.id, body: schema.ticketMessages.body }).from(schema.ticketMessages).where(eq(schema.ticketMessages.zohoNoteId, key));
  if (have?.body === text) return false;
  await asZoho(async (tx) => {
    if (have) await tx.update(schema.ticketMessages).set({ body: text }).where(eq(schema.ticketMessages.id, have.id));
    else
      await tx.insert(schema.ticketMessages).values({
        ticketId,
        authorType: "agent",
        authorName: "Whyte (solution in Zoho)",
        body: text,
        channel: "zoho",
        zohoNoteId: key,
        createdAt: c.Modified_Time ? new Date(c.Modified_Time) : new Date(),
      });
  });
  return true;
}

async function feedKb(ticketId: string) {
  await enqueueTicket(ticketId).catch((err) => log.warn("Couldn't queue a Zoho case for the knowledge base", { err }));
}

async function createTicketFromCase(c: ZCase, maps: Awaited<ReturnType<typeof caseMaps>>, opts: CaseOptions) {
  const history = opts.history ?? false;
  let contactId: string | null = null;
  if (c.Related_To?.id) {
    const res = await zoho<{ data: ZContact[] }>("GET", `/Contacts/${c.Related_To.id}`, { query: { fields: CONTACT_FIELDS.join(",") } }).catch(() => null);
    const zc = res?.data?.[0];
    if (zc) contactId = await applyContact(zc, { create: true });
  } else if (c.Email) {
    contactId = await applyContact({ Email: c.Email, Phone: c.Phone }, { create: true });
  }
  const [contact] = contactId ? await db().select().from(schema.contacts).where(eq(schema.contacts.id, contactId)) : [];
  const account = await localAccount(c.Account_Name?.id);
  const status = maps.toStatus.get(c.Status ?? "") ?? "open";
  const priority = maps.toPriority.get(c.Priority ?? "") ?? "normal";
  const created = c.Created_Time ? new Date(c.Created_Time) : new Date();
  const modified = c.Modified_Time ? new Date(c.Modified_Time) : created;
  const done = status === "resolved" || status === "closed";
  const incoming = {
    [CASE_FIELDS.subject]: (c.Subject ?? "").slice(0, 255),
    [CASE_FIELDS.status]: c.Status ?? "",
    [CASE_FIELDS.priority]: c.Priority ?? "",
    ...(c.Related_To?.id ? { [CASE_FIELDS.contact]: { id: c.Related_To.id } } : {}),
    ...(c.Account_Name?.id ? { [CASE_FIELDS.account]: { id: c.Account_Name.id } } : {}),
  };
  const ticketId = await asZoho(async (tx) => {
    const [t] = await tx
      .insert(schema.tickets)
      .values({
        segment: contact?.segment === "b2b" || account?.isDealer ? "b2b" : "b2c",
        subject: (c.Subject || "Case from Zoho").slice(0, 300),
        status,
        priority,
        source: "zoho",
        contactId,
        zohoCaseId: c.id,
        zohoCaseNumber: c.Case_Number ?? null,
        zohoHash: hashFields(incoming),
        replyToken: randomBytes(12).toString("base64url"),
        createdAt: created,
        updatedAt: modified,
        resolvedAt: done ? modified : null,
        closedAt: status === "closed" ? modified : null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.tickets.id, number: schema.tickets.number });
    if (!t) return null; // created by a parallel run
    if (c.Description?.trim()) {
      await tx.insert(schema.ticketMessages).values({
        ticketId: t.id,
        authorType: "customer",
        authorName: contact?.name || contact?.email || "Customer",
        body: c.Description.trim(),
        channel: "zoho",
        zohoNoteId: `case:${c.id}`,
        createdAt: created,
      });
    }
    await tx.insert(schema.ticketEvents).values({ ticketId: t.id, actorLabel: "Zoho CRM", type: "created", toValue: "zoho", createdAt: created });
    return t.id;
  });
  if (!ticketId) return;
  await syncSolution(ticketId, c);
  await pullNotes(c.id, ticketId);
  if (done && opts.feedKb !== false) await feedKb(ticketId);
  if (!history) await logSync({ direction: "in", entity: "ticket", entityId: ticketId, zohoId: c.id, message: `New case ${c.Case_Number ?? c.id} from Zoho became a ticket.` });
}

/** Notes added in Zoho become internal notes on the ticket (never emailed). */
export async function pullNotes(caseId: string, ticketId: string): Promise<number> {
  let added = 0;
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await zoho<{ data: ZNote[]; info?: { more_records?: boolean; next_page_token?: string } }>("GET", `/Cases/${caseId}/Notes`, {
      query: { fields: "Note_Title,Note_Content,Created_Time,Created_By", per_page: 200, page_token: pageToken },
    });
    const notes = res?.data ?? [];
    if (notes.length) {
      const known = new Set(
        (await db().select({ id: schema.ticketMessages.zohoNoteId }).from(schema.ticketMessages).where(eq(schema.ticketMessages.ticketId, ticketId))).map((r) => r.id),
      );
      const fresh = notes.filter((n) => !known.has(n.id) && (n.Note_Content ?? "").trim());
      if (fresh.length) {
        await asZoho((tx) =>
          tx
            .insert(schema.ticketMessages)
            .values(
              fresh.map((n) => ({
                ticketId,
                authorType: "agent" as const,
                authorName: n.Created_By?.name ? `${n.Created_By.name} (Zoho)` : "Zoho CRM",
                body: [n.Note_Title?.trim(), n.Note_Content!.trim()].filter(Boolean).join("\n\n"),
                internal: true,
                channel: "zoho" as const,
                zohoNoteId: n.id,
                createdAt: n.Created_Time ? new Date(n.Created_Time) : new Date(),
              })),
            )
            .onConflictDoNothing(),
        );
        added += fresh.length;
      }
    }
    if (!res?.info?.more_records || !res.info.next_page_token) break;
    pageToken = res.info.next_page_token;
  }
  return added;
}

/* ---------- Reconcile: everything modified since the last run ---------- */

interface Cursor {
  since: string;
  page: number;
}

const APPLY: Record<Module, (r: never, opts: CaseOptions) => Promise<unknown>> = {
  Accounts: (r: ZAccount) => applyAccount(r),
  Contacts: (r: ZContact) => applyContact(r),
  Cases: (r: ZCase, opts: CaseOptions) => applyCase(r, { withNotes: true, ...opts }),
};

/**
 * Pages through a module's records modified since the cursor, oldest first,
 * moving the cursor as it goes so a run can stop at its deadline and the next
 * carries on. Returns how many records were applied and whether it's caught up.
 */
export async function pullModule(module: Module, stateKey: string, deadline: number, opts: Omit<CaseOptions, "withNotes"> = {}): Promise<{ applied: number; done: boolean }> {
  const cursor = (await readState<Cursor>(stateKey)) ?? { since: new Date().toISOString(), page: 1 };
  let applied = 0;
  while (Date.now() < deadline) {
    const res = await zoho<{ data: { id: string; Modified_Time?: string }[]; info?: { more_records?: boolean } }>("GET", `/${module}`, {
      query: { fields: MODULES[module].join(","), sort_by: "Modified_Time", sort_order: "asc", per_page: 200, page: cursor.page },
      headers: { "If-Modified-Since": zohoTime(cursor.since) },
    });
    const records = res?.data ?? [];
    for (const r of records) {
      if (Date.now() >= deadline) {
        await writeState(stateKey, cursor);
        return { applied, done: false };
      }
      await APPLY[module](r as never, opts);
      applied++;
    }
    const last = records.at(-1)?.Modified_Time;
    if (!res?.info?.more_records) {
      if (last) cursor.since = last;
      cursor.page = 1;
      await writeState(stateKey, cursor);
      return { applied, done: true };
    }
    // Move the window on; only page forward when a whole page shares one timestamp.
    if (last && last !== cursor.since) {
      cursor.since = last;
      cursor.page = 1;
    } else cursor.page++;
    await writeState(stateKey, cursor);
  }
  return { applied, done: false };
}

/** Zoho wants ISO 8601 with an offset and no milliseconds: 2026-11-23T16:46:50+00:00. */
export function zohoTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export const cursorKey = (m: Module) => `zoho.cursor.${m}`;

/** Fetches records Zoho told us about (a notification) and applies them. */
export async function applyNotified(module: string, ids: string[], operation: string): Promise<void> {
  if (!["Accounts", "Contacts", "Cases"].includes(module)) return;
  if (operation === "delete") {
    await logSync({ direction: "in", entity: module.toLowerCase(), zohoId: ids.join(","), level: "warning", message: `${ids.length} ${module.toLowerCase()} deleted in Zoho. Nothing is deleted here; check whether that was intended.` });
    return;
  }
  const m = module as Module;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await zoho<{ data: { id: string }[] }>("GET", `/${m}`, { query: { ids: batch.join(","), fields: MODULES[m].join(",") } });
    for (const r of res?.data ?? []) await APPLY[m](r as never, {});
  }
}

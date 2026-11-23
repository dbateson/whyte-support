import "server-only";
import { and, asc, count, desc, eq, inArray, isNotNull, like, notLike, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { KbAudience } from "../db/schema";
import { createArticle } from "../kb/service";
import { log } from "../logger";
import { IMPORT_BUCKET, objectStore } from "../storage";
import { ref } from "../tickets/format";
import { draftFromConversations, draftFromPage, extract, type Extraction } from "./llm";
import { redact } from "./redact";
import { htmlToText, parseEmail, parseSitemap, parseZohoCases } from "./sources";

/**
 * The ingestion pipeline. A job moves through:
 *   importing   read the source in steps (emails, a Zoho export, web pages)
 *   extracting  Claude pulls a question, an answer and a topic from each item
 *   drafting    topics with enough conversations become draft articles
 *   done
 * Each call to runStep does a bounded amount of work, so it fits in one
 * serverless invocation; the Import page and the nightly job keep calling it.
 */

export type Job = typeof schema.ingestJobs.$inferSelect;
type Item = typeof schema.ingestItems.$inferSelect;

export interface Actor {
  id?: string;
  label: string;
}

/** How many conversations on one topic it takes to draft an article. */
export const DRAFT_THRESHOLD = 2;
const READ_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_WEB_PAGES = 300;
const MESSAGE_PREFIX = "msg:";

export interface WebParams {
  sitemapUrl: string;
  include: ("pages" | "products" | "blogs")[];
  urls?: string[];
  index?: number;
}

/** Starts a job. Files must already be in storage (uploaded with signed URLs). */
export async function createJob(
  input: { kind: Job["kind"]; label: string; defaultAudience: KbAudience; params: Record<string, unknown> },
  actor: Actor,
): Promise<Job> {
  const [job] = await db()
    .insert(schema.ingestJobs)
    .values({ kind: input.kind, label: input.label, defaultAudience: input.defaultAudience, params: input.params, createdBy: actor.id ?? null })
    .returning();
  await db().insert(schema.auditLog).values({ actorId: actor.id ?? null, actorLabel: actor.label, action: "ingest.start", target: job!.id, detail: { kind: input.kind, label: input.label } });
  return job!;
}

async function setJob(id: string, patch: Partial<typeof schema.ingestJobs.$inferInsert>) {
  const [j] = await db().update(schema.ingestJobs).set({ ...patch, updatedAt: new Date() }).where(eq(schema.ingestJobs.id, id)).returning();
  return j!;
}

/** Inserts items, skipping ones already imported (by kind and external id). Returns how many were new. */
async function addItems(rows: (typeof schema.ingestItems.$inferInsert)[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db().insert(schema.ingestItems).values(rows).onConflictDoNothing().returning({ id: schema.ingestItems.id });
  return inserted.length;
}

/* ---------- Importing ---------- */

async function importMbox(job: Job, origin: string, deadline: number): Promise<boolean> {
  let p = job.params as { key: string; size: number; offset?: number; staffDomains: string[]; more?: { key: string; size: number }[] };
  // Several .mbox files: read them one after another.
  if ((p.offset ?? 0) >= p.size && p.more?.length) {
    await (await objectStore(origin, IMPORT_BUCKET)).remove([p.key]).catch(() => undefined);
    const [next, ...rest] = p.more;
    p = { ...p, key: next!.key, size: next!.size, offset: 0, more: rest };
    await setJob(job.id, { params: p });
  }
  const store = await objectStore(origin, IMPORT_BUCKET);
  let offset = p.offset ?? 0;
  while (Date.now() < deadline && offset < p.size) {
    let length = READ_BYTES;
    let buf: Buffer;
    let end: number;
    // Read until the piece holds at least one whole message (ends before the next "From " line).
    for (;;) {
      buf = await store.readRange(p.key, offset, length);
      const atEof = offset + buf.length >= p.size;
      const cut = atEof ? buf.length : buf.lastIndexOf("\nFrom ");
      if (cut > 0) {
        end = cut + (atEof ? 0 : 1);
        break;
      }
      if (length >= MAX_FILE_BYTES) throw new Error("A single email in the file is larger than 50 MB.");
      length *= 2;
    }
    const text = buf.subarray(0, end).toString("utf8");
    const raws = text.split(/^From [^\n]*\n/m).filter((m) => m.trim()).map((m) => m.replace(/^>(>*From )/gm, "$1"));
    await stageMessages(job, raws, p.staffDomains);
    offset += end;
    await setJob(job.id, { params: { ...p, offset }, stats: { ...(job.stats as object), bytesRead: offset } });
  }
  return offset >= p.size && !p.more?.length;
}

async function importEml(job: Job, origin: string, deadline: number): Promise<boolean> {
  const p = job.params as { keys: string[]; index?: number; staffDomains: string[] };
  const store = await objectStore(origin, IMPORT_BUCKET);
  let i = p.index ?? 0;
  while (Date.now() < deadline && i < p.keys.length) {
    const batch = p.keys.slice(i, i + 25);
    const raws = await Promise.all(batch.map(async (k) => (await store.readRange(k, 0, MAX_FILE_BYTES)).toString("utf8")));
    await stageMessages(job, raws, p.staffDomains);
    i += batch.length;
    await setJob(job.id, { params: { ...p, index: i } });
  }
  return i >= p.keys.length;
}

/** Each email becomes a staging row ("msg:<Message-ID>") until threads are assembled. */
async function stageMessages(job: Job, raws: string[], staffDomains: string[]) {
  const rows: (typeof schema.ingestItems.$inferInsert)[] = [];
  for (const raw of raws) {
    try {
      const e = await parseEmail(raw, staffDomains);
      if (!e) continue;
      rows.push({
        jobId: job.id,
        kind: job.kind,
        externalId: `${MESSAGE_PREFIX}${e.messageId}`,
        title: e.subject,
        content: e.text,
        status: "pending",
        extraction: { stage: "message", messageId: e.messageId, threadKey: e.threadKey, subjectKey: e.subjectKey, fromStaff: e.fromStaff, date: e.date },
      });
    } catch (err) {
      log.warn("Skipped an email that couldn't be parsed", { err });
    }
  }
  await addItems(rows);
}

/**
 * Joins staged emails into conversations, oldest first, labelled Customer or
 * Whyte. A conversation needs a reply from Whyte to teach anything.
 */
async function assembleThreads(job: Job): Promise<void> {
  const messages = await db()
    .select()
    .from(schema.ingestItems)
    .where(and(eq(schema.ingestItems.jobId, job.id), like(schema.ingestItems.externalId, `${MESSAGE_PREFIX}%`)));
  // Union-find: a message joins its thread's root, and messages with the same
  // subject join each other (some mail clients drop the reference headers).
  type Meta = { messageId: string; threadKey: string; subjectKey: string; fromStaff: boolean; date?: string };
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const m of messages) {
    const x = m.extraction as Meta;
    parent.set(x.messageId, parent.get(x.messageId) ?? x.messageId);
    parent.set(x.threadKey, parent.get(x.threadKey) ?? x.threadKey);
    union(x.threadKey, x.messageId);
    if (x.subjectKey.length >= 4) {
      const sk = `subject:${x.subjectKey}`;
      parent.set(sk, parent.get(sk) ?? sk);
      union(sk, x.messageId);
    }
  }
  const threads = new Map<string, Item[]>();
  for (const m of messages) {
    const key = find((m.extraction as Meta).messageId);
    threads.set(key, [...(threads.get(key) ?? []), m]);
  }
  const rows: (typeof schema.ingestItems.$inferInsert)[] = [];
  for (const list of threads.values()) {
    const sorted = list.sort((a, b) => Date.parse(String((a.extraction as { date?: string }).date ?? 0)) - Date.parse(String((b.extraction as { date?: string }).date ?? 0)));
    const staff = sorted.some((m) => (m.extraction as { fromStaff: boolean }).fromStaff);
    const customer = sorted.some((m) => !(m.extraction as { fromStaff: boolean }).fromStaff);
    const content = sorted.map((m) => `${(m.extraction as { fromStaff: boolean }).fromStaff ? "Whyte" : "Customer"}:\n${m.content}`).join("\n\n");
    // The thread is named by its oldest message, so re-imports match.
    const key = (sorted[0]!.extraction as Meta).threadKey;
    rows.push({
      jobId: job.id,
      kind: job.kind,
      externalId: `thread:${key}`,
      title: sorted.find((m) => m.title)?.title ?? "",
      content,
      status: staff && customer ? "pending" : "skipped",
      error: staff && customer ? null : "No reply from Whyte in this conversation.",
    });
  }
  for (let i = 0; i < rows.length; i += 500) await addItems(rows.slice(i, i + 500));
  await db().delete(schema.ingestItems).where(and(eq(schema.ingestItems.jobId, job.id), like(schema.ingestItems.externalId, `${MESSAGE_PREFIX}%`)));
}

async function importZoho(job: Job, origin: string): Promise<boolean> {
  const p = job.params as { key: string };
  const store = await objectStore(origin, IMPORT_BUCKET);
  const csv = (await store.readRange(p.key, 0, MAX_FILE_BYTES)).toString("utf8");
  const cases = parseZohoCases(csv);
  for (let i = 0; i < cases.length; i += 500) {
    await addItems(
      cases.slice(i, i + 500).map((c) => ({
        jobId: job.id,
        kind: "zoho_csv" as const,
        externalId: c.externalId,
        title: c.title,
        content: c.text,
        audience: c.audienceHint,
        status: "pending" as const,
      })),
    );
  }
  return true;
}

/**
 * Fetches a page of the site being imported. Every URL, including each
 * redirect hop, must be on the sitemap's own origin (whytebikes.com in
 * production), so a sitemap entry or redirect can't point the crawler at
 * internal addresses.
 */
async function fetchText(url: string, origin: string, timeoutMs = 10_000): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new Error(`Not a web address: ${current}`);
    }
    if (u.origin !== origin) throw new Error(`Skipped ${u.origin}: only ${origin} is imported`);
    const res = await fetch(u, { headers: { "user-agent": "WhyteSupportKnowledgeBase/1.0", accept: "text/html,application/xml" }, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`${u.toString()} returned ${res.status}`);
    const text = await res.text();
    return text.length > 5_000_000 ? text.slice(0, 5_000_000) : text;
  }
  throw new Error(`Too many redirects from ${url}`);
}

const TYPE_PATHS: Record<WebParams["include"][number], RegExp> = { pages: /\/pages\//, products: /\/products\//, blogs: /\/blogs\// };

async function importWeb(job: Job, deadline: number): Promise<boolean> {
  const p = job.params as unknown as WebParams;
  let urls = p.urls;
  const origin = new URL(p.sitemapUrl).origin;
  if (!urls) {
    // Read the sitemap (Shopify serves an index of per-type sitemaps).
    const root = parseSitemap(await fetchText(p.sitemapUrl, origin));
    const pages = [...root.pages];
    for (const sm of root.sitemaps) {
      const type = /sitemap_(\w+?)_\d/.exec(sm)?.[1];
      if (type && !(p.include as string[]).includes(type)) continue;
      pages.push(...parseSitemap(await fetchText(sm, origin)).pages);
    }
    urls = [...new Set(pages.filter((u) => u.startsWith(`${origin}/`) && p.include.some((t) => TYPE_PATHS[t].test(u))))].slice(0, MAX_WEB_PAGES);
    await setJob(job.id, { params: { ...p, urls, index: 0 }, stats: { ...(job.stats as object), pagesFound: urls.length } });
  }
  let i = p.index ?? 0;
  while (Date.now() < deadline && i < urls.length) {
    const batch = urls.slice(i, i + 6);
    const pages = await Promise.all(
      batch.map(async (url) => {
        try {
          const { title, text } = htmlToText(await fetchText(url, origin));
          return text.length > 200 ? { url, title, text } : null;
        } catch (err) {
          log.warn("Couldn't fetch a page", { url, err });
          return null;
        }
      }),
    );
    await addItems(pages.filter((x): x is NonNullable<typeof x> => x !== null).map((pg) => ({ jobId: job.id, kind: "web" as const, externalId: pg.url, title: pg.title, content: pg.text, status: "pending" as const })));
    i += batch.length;
    await setJob(job.id, { params: { ...p, urls, index: i } });
  }
  return i >= urls.length;
}

/** Raw exports hold personal data: once read (and redacted into items), the uploaded files are deleted. */
async function removeSourceFiles(job: Job, origin: string) {
  const p = job.params as { key?: string; keys?: string[]; more?: { key: string }[] };
  const keys = [p.key, ...(p.keys ?? [])].filter((k): k is string => Boolean(k));
  if (keys.length === 0) return;
  try {
    await (await objectStore(origin, IMPORT_BUCKET)).remove(keys);
  } catch (err) {
    log.warn("Couldn't delete an imported file after reading it", { err, job: job.id });
  }
}

/* ---------- Extracting and drafting ---------- */

async function knownTopics(): Promise<string[]> {
  const rows = await db()
    .select({ topic: schema.ingestItems.topic, n: count() })
    .from(schema.ingestItems)
    .where(isNotNull(schema.ingestItems.topic))
    .groupBy(schema.ingestItems.topic)
    .orderBy(desc(count()))
    .limit(150);
  return rows.map((r) => r.topic!).filter(Boolean);
}

const cleanTopic = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "general";

async function extractStep(job: Job, deadline: number): Promise<boolean> {
  const topics = await knownTopics();
  while (Date.now() < deadline) {
    const items = await db()
      .select()
      .from(schema.ingestItems)
      .where(and(eq(schema.ingestItems.jobId, job.id), eq(schema.ingestItems.status, "pending"), notLike(schema.ingestItems.externalId, `${MESSAGE_PREFIX}%`)))
      .orderBy(asc(schema.ingestItems.createdAt))
      .limit(job.kind === "web" ? 2 : 5);
    if (items.length === 0) return true;
    await Promise.all(items.map((it) => (it.kind === "web" ? draftWebItem(job, it) : extractItem(job, it, topics))));
  }
  return false;
}

async function extractItem(job: Job, it: Item, topics: string[]) {
  try {
    const x = await extract(it.content, topics);
    if (!x) {
      await db().update(schema.ingestItems).set({ status: "failed", error: "The model declined or ran out of room.", updatedAt: new Date() }).where(eq(schema.ingestItems.id, it.id));
      return;
    }
    const useful = x.relevant && x.answer.trim().length > 0;
    const topic = cleanTopic(x.topic);
    if (useful && !topics.includes(topic)) topics.push(topic);
    const audience: KbAudience | null = x.audience === "unknown" ? (it.audience ?? null) : x.audience;
    await db()
      .update(schema.ingestItems)
      .set({ status: useful ? "extracted" : "skipped", topic: useful ? topic : null, audience, extraction: x, error: useful ? null : "Nothing reusable.", updatedAt: new Date() })
      .where(eq(schema.ingestItems.id, it.id));
  } catch (err) {
    log.warn("Extraction failed", { err, item: it.id });
    await db().update(schema.ingestItems).set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : "Failed", updatedAt: new Date() }).where(eq(schema.ingestItems.id, it.id));
  }
}

async function draftWebItem(job: Job, it: Item) {
  try {
    const d = await draftFromPage(it.externalId, it.title, it.content);
    if (!d || !d.relevant || d.body.trim().length < 40) {
      await db().update(schema.ingestItems).set({ status: "skipped", error: d ? "Not support content." : "The model declined.", updatedAt: new Date() }).where(eq(schema.ingestItems.id, it.id));
      return;
    }
    const { article } = await createArticle(
      { title: d.title, body: withUnsure(d.body, d.unsure), audience: d.audience, category: d.category, origin: "ingestion", sources: [{ kind: "web", reference: it.externalId, title: it.title }] },
      { label: "Claude (from a whytebikes.com page)" },
    );
    await db().update(schema.ingestItems).set({ status: "drafted", articleId: article.id, updatedAt: new Date() }).where(eq(schema.ingestItems.id, it.id));
  } catch (err) {
    log.warn("Drafting from a page failed", { err, item: it.id });
    await db().update(schema.ingestItems).set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : "Failed", updatedAt: new Date() }).where(eq(schema.ingestItems.id, it.id));
  }
}

/** Points the reviewer at what the model wasn't sure of, as a note they delete before publishing. */
function withUnsure(body: string, unsure: string[]): string {
  if (unsure.length === 0) return body;
  return `${body}\n\n## For the reviewer (delete before publishing)\n\nThe sources didn't settle these:\n\n${unsure.map((u) => `- ${u}`).join("\n")}`;
}

const SOURCE_KIND = { mbox: "email", eml: "email", zoho_csv: "zoho_case", ticket: "ticket", web: "web" } as const;
const SOURCE_NOUN = { email: "emails", zoho_case: "Zoho cases", ticket: "tickets", web: "pages" } as const;

/** Drafts an article for each topic with enough conversations (from any import), or adds to the one already drafted. */
export async function draftStep(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const [group] = await db()
      .select({ topic: schema.ingestItems.topic, n: count() })
      .from(schema.ingestItems)
      .where(and(eq(schema.ingestItems.status, "extracted"), isNotNull(schema.ingestItems.topic)))
      .groupBy(schema.ingestItems.topic)
      .having(sql`count(*) >= ${DRAFT_THRESHOLD}`)
      .orderBy(desc(count()))
      .limit(1);
    if (!group?.topic) {
      // Topics already drafted take new conversations as extra sources.
      return attachToDraftedTopics();
    }
    await draftTopic(group.topic);
  }
  return false;
}

async function attachToDraftedTopics(): Promise<boolean> {
  const waiting = await db()
    .select({ id: schema.ingestItems.id, topic: schema.ingestItems.topic, kind: schema.ingestItems.kind, externalId: schema.ingestItems.externalId, title: schema.ingestItems.title })
    .from(schema.ingestItems)
    .where(and(eq(schema.ingestItems.status, "extracted"), isNotNull(schema.ingestItems.topic)))
    .limit(500);
  if (waiting.length === 0) return true;
  const topics = [...new Set(waiting.map((w) => w.topic!))];
  const drafted = await db()
    .selectDistinct({ topic: schema.ingestItems.topic, articleId: schema.ingestItems.articleId })
    .from(schema.ingestItems)
    .where(and(eq(schema.ingestItems.status, "drafted"), inArray(schema.ingestItems.topic, topics), isNotNull(schema.ingestItems.articleId)));
  const articleFor = new Map(drafted.map((d) => [d.topic!, d.articleId!]));
  for (const w of waiting) {
    const articleId = articleFor.get(w.topic!);
    if (!articleId) continue;
    await db().insert(schema.kbSources).values({ articleId, kind: SOURCE_KIND[w.kind], reference: sourceRef(w), title: w.title || null });
    await db().update(schema.ingestItems).set({ status: "drafted", articleId, updatedAt: new Date() }).where(eq(schema.ingestItems.id, w.id));
  }
  return true;
}

const sourceRef = (it: { kind: Item["kind"]; externalId: string }) => (it.kind === "mbox" || it.kind === "eml" ? it.externalId.replace(/^thread:/, "") : it.externalId);

/** Writes the draft for one topic from up to 12 of its conversations (or just the ones given). */
export async function draftTopic(topic: string, onlyIds?: string[]): Promise<string | null> {
  const items = await db()
    .select()
    .from(schema.ingestItems)
    .where(
      and(
        eq(schema.ingestItems.status, "extracted"),
        eq(schema.ingestItems.topic, topic),
        onlyIds ? inArray(schema.ingestItems.id, onlyIds) : undefined,
      ),
    )
    .orderBy(desc(schema.ingestItems.createdAt))
    .limit(12);
  if (items.length === 0) return null;
  const x = items.map((i) => i.extraction as Extraction);
  try {
    const d = await draftFromConversations(topic, x.map((e) => ({ question: e.question, answer: e.answer, product: e.product })));
    if (!d || !d.relevant || d.body.trim().length < 40) {
      await db().update(schema.ingestItems).set({ status: "skipped", error: "Not enough for an article.", updatedAt: new Date() }).where(inArray(schema.ingestItems.id, items.map((i) => i.id)));
      return null;
    }
    const audiences = new Set(items.map((i) => i.audience).filter(Boolean));
    const audience: KbAudience = audiences.size === 1 ? ([...audiences][0] as KbAudience) : d.audience;
    const kinds = new Set(items.map((i) => SOURCE_KIND[i.kind]));
    const noun = kinds.size === 1 ? SOURCE_NOUN[[...kinds][0]!] : "past conversations";
    const { article } = await createArticle(
      {
        title: d.title,
        body: withUnsure(d.body, d.unsure),
        audience,
        category: d.category,
        origin: items.every((i) => i.kind === "ticket") ? "ticket" : "ingestion",
        sources: items.map((i) => ({ kind: SOURCE_KIND[i.kind], reference: sourceRef(i), title: i.title || null })),
      },
      { label: `Claude (from ${items.length} ${noun})` },
    );
    await db().update(schema.ingestItems).set({ status: "drafted", articleId: article.id, updatedAt: new Date() }).where(inArray(schema.ingestItems.id, items.map((i) => i.id)));
    return article.id;
  } catch (err) {
    log.warn("Drafting failed", { err, topic });
    await db().update(schema.ingestItems).set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : "Failed", updatedAt: new Date() }).where(inArray(schema.ingestItems.id, items.map((i) => i.id)));
    return null;
  }
}

/* ---------- Driving a job ---------- */

export async function jobStats(jobId: string) {
  const rows = await db()
    .select({ status: schema.ingestItems.status, n: count() })
    .from(schema.ingestItems)
    .where(and(eq(schema.ingestItems.jobId, jobId), notLike(schema.ingestItems.externalId, `${MESSAGE_PREFIX}%`)))
    .groupBy(schema.ingestItems.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const articles = await db()
    .selectDistinct({ id: schema.ingestItems.articleId })
    .from(schema.ingestItems)
    .where(and(eq(schema.ingestItems.jobId, jobId), isNotNull(schema.ingestItems.articleId)));
  return { pending: by.pending ?? 0, extracted: by.extracted ?? 0, skipped: by.skipped ?? 0, drafted: by.drafted ?? 0, failed: by.failed ?? 0, articles: articles.length };
}

/** Does up to `budgetMs` of work on a job and returns its new state. */
export async function runStep(jobId: string, origin: string, budgetMs = 40_000): Promise<Job> {
  const deadline = Date.now() + budgetMs;
  let [job] = await db().select().from(schema.ingestJobs).where(eq(schema.ingestJobs.id, jobId));
  if (!job) throw new Error("No such import.");
  try {
    if (job.status === "importing") {
      const finished =
        job.kind === "mbox"
          ? await importMbox(job, origin, deadline)
          : job.kind === "eml"
            ? await importEml(job, origin, deadline)
            : job.kind === "zoho_csv"
              ? await importZoho(job, origin)
              : job.kind === "web"
                ? await importWeb(job, deadline)
                : true;
      [job] = await db().select().from(schema.ingestJobs).where(eq(schema.ingestJobs.id, jobId));
      if (finished) {
        if (job!.kind === "mbox" || job!.kind === "eml") await assembleThreads(job!);
        await removeSourceFiles(job!, origin);
        job = await setJob(jobId, { status: "extracting" });
      }
    }
    if (job!.status === "extracting" && Date.now() < deadline) {
      if (await extractStep(job!, deadline)) job = await setJob(jobId, { status: job!.kind === "web" ? "done" : "drafting", finishedAt: job!.kind === "web" ? new Date() : null });
    }
    if (job!.status === "drafting" && Date.now() < deadline) {
      if (await draftStep(deadline)) job = await setJob(jobId, { status: "done", finishedAt: new Date() });
    }
    return await setJob(jobId, { stats: { ...(job!.stats as object), ...(await jobStats(jobId)) } });
  } catch (err) {
    log.error("Import step failed", { err, jobId });
    return setJob(jobId, { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "Failed" });
  }
}

/** Advances every unfinished import for a while (the nightly job). */
export async function advanceAll(origin: string, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const open = await db().select({ id: schema.ingestJobs.id }).from(schema.ingestJobs).where(inArray(schema.ingestJobs.status, ["importing", "extracting", "drafting"]));
  let n = 0;
  for (const j of open) {
    if (Date.now() > deadline - 5_000) break;
    await runStep(j.id, origin, Math.min(60_000, deadline - Date.now() - 5_000));
    n++;
  }
  return n;
}

/* ---------- Resolved tickets ---------- */

/** The standing job that collects resolved tickets. */
async function ticketJob(): Promise<Job> {
  const [existing] = await db().select().from(schema.ingestJobs).where(eq(schema.ingestJobs.kind, "ticket")).orderBy(asc(schema.ingestJobs.createdAt)).limit(1);
  if (existing) return existing;
  const [job] = await db().insert(schema.ingestJobs).values({ kind: "ticket", label: "Resolved tickets", status: "extracting" }).returning();
  return job!;
}

/**
 * Queues a resolved ticket's conversation (customer and Whyte replies, never
 * internal notes) for extraction. Re-resolving updates it unless it was
 * already used in a draft.
 */
export async function enqueueTicket(ticketId: string): Promise<void> {
  const [t] = await db().select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  if (!t) return;
  const messages = await db()
    .select()
    .from(schema.ticketMessages)
    .where(and(eq(schema.ticketMessages.ticketId, ticketId), eq(schema.ticketMessages.internal, false)))
    .orderBy(asc(schema.ticketMessages.createdAt));
  if (!messages.some((m) => m.authorType === "agent") || !messages.some((m) => m.authorType === "customer")) return;
  const content = redact(messages.map((m) => `${m.authorType === "customer" ? "Customer" : "Whyte"}:\n${m.body}`).join("\n\n"));
  const job = await ticketJob();
  const [existing] = await db().select().from(schema.ingestItems).where(and(eq(schema.ingestItems.kind, "ticket"), eq(schema.ingestItems.externalId, ref(t.number))));
  if (existing?.status === "drafted") return;
  if (existing) {
    await db().update(schema.ingestItems).set({ content, title: t.subject, status: "pending", audience: t.segment, updatedAt: new Date() }).where(eq(schema.ingestItems.id, existing.id));
  } else {
    await addItems([{ jobId: job.id, kind: "ticket", externalId: ref(t.number), title: t.subject, content, audience: t.segment, status: "pending" }]);
  }
  if (job.status === "done") await setJob(job.id, { status: "extracting", finishedAt: null });
}

/** "Draft an article from this ticket": extracts and drafts at once, from this ticket alone. */
export async function draftFromTicket(ticketId: string): Promise<string | null> {
  await enqueueTicket(ticketId);
  const [t] = await db().select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
  const [item] = await db().select().from(schema.ingestItems).where(and(eq(schema.ingestItems.kind, "ticket"), eq(schema.ingestItems.externalId, ref(t!.number))));
  if (!item) return null;
  if (item.status === "drafted") return item.articleId;
  const job = await ticketJob();
  await extractItem(job, item, await knownTopics());
  const [after] = await db().select().from(schema.ingestItems).where(eq(schema.ingestItems.id, item.id));
  if (after?.status !== "extracted" || !after.topic) return null;
  // Draft from this ticket only, so a one-off topic still gets an article.
  return draftTopic(after.topic, [after.id]);
}

/** GDPR: imported text that never became part of an article is deleted after 90 days. */
export async function purgeStaleIngestItems(): Promise<void> {
  await db()
    .delete(schema.ingestItems)
    .where(and(inArray(schema.ingestItems.status, ["pending", "skipped", "failed", "extracted"]), sql`${schema.ingestItems.updatedAt} < now() - interval '90 days'`));
}

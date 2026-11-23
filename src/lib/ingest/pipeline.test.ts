import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";
import { IMPORT_BUCKET, objectStore, writeLocalObject } from "../storage";

// Claude is replaced by a stand-in that reads the text the way the prompt asks.
vi.mock("./llm", () => ({
  extract: vi.fn(async (conversation: string) => {
    if (/unsubscribe|newsletter/i.test(conversation)) return { relevant: false, audience: "unknown", topic: "spam", question: "", answer: "", product: null, confidence: "high" };
    const creak = /creak/i.test(conversation);
    return {
      relevant: true,
      audience: /shop|dealer/i.test(conversation) ? "b2b" : "b2c",
      topic: creak ? "Bottom Bracket Creak" : "frame-warranty-claim",
      question: creak ? "Why does my bottom bracket creak?" : "Is a cracked frame covered?",
      answer: creak ? "Clean and regrease the bottom bracket shell." : "Yes, send photos and the frame number.",
      product: null,
      confidence: "high",
    };
  }),
  draftFromConversations: vi.fn(async (topic: string, items: { question: string }[]) => ({
    relevant: true,
    title: items[0]!.question,
    audience: "b2c",
    category: "Technical",
    body: `## Answer\n\nDrafted from ${items.length} conversations about ${topic}.`,
    unsure: ["Whether it applies to e-bikes"],
  })),
  draftFromPage: vi.fn(async (_url: string, title: string, text: string) =>
    /warranty/i.test(text)
      ? { relevant: true, title: `${title}: what's covered?`, audience: "both", category: "Warranty", body: "## Cover\n\nFrames are covered for five years from purchase.", unsure: [] }
      : { relevant: false, title: "", audience: "both", category: "Other", body: "", unsure: [] },
  ),
}));

const { createJob, enqueueTicket, runStep, draftFromTicket } = await import("./pipeline");
const { createTicket, addStaffMessage, updateTicket } = await import("../tickets/service");

const ORIGIN = "http://localhost:3000";

function email(id: string, from: string, subject: string, body: string, refs = "") {
  return `From ${from} Tue Nov 12 09:00:00 2026\nFrom: ${from}\nSubject: ${subject}\nMessage-ID: ${id}\n${refs ? `References: ${refs}\nIn-Reply-To: ${refs}\n` : ""}Date: Tue, 12 Nov 2026 0${id.length % 9}:00:00 +0000\nContent-Type: text/plain\n\n${body}\n\n`;
}

async function finish(jobId: string) {
  for (let i = 0; i < 20; i++) {
    const job = await runStep(jobId, ORIGIN, 10_000);
    if (["done", "failed", "cancelled"].includes(job.status)) return job;
  }
  throw new Error("Job didn't finish");
}

describe.skipIf(!TEST_DATABASE_URL)("ingestion pipeline", () => {
  const { sql, reset } = useTestDatabase();
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const pages: Record<string, string> = {
        "/sitemap.xml": `<sitemapindex><sitemap><loc>${base}/sitemap_pages_1.xml</loc></sitemap><sitemap><loc>${base}/sitemap_products_1.xml</loc></sitemap></sitemapindex>`,
        // The last entry points elsewhere (an internal address): it must never be fetched.
        "/sitemap_pages_1.xml": `<urlset><url><loc>${base}/pages/warranty</loc></url><url><loc>${base}/pages/about</loc></url><url><loc>http://169.254.169.254/pages/latest</loc></url></urlset>`,
        "/sitemap_products_1.xml": `<urlset><url><loc>${base}/products/905</loc></url></urlset>`,
        "/pages/warranty": `<html><body><nav>Menu</nav><main><h1>Warranty</h1><p>${"Our frames carry a warranty against manufacturing defects. ".repeat(6)}</p></main></body></html>`,
        "/pages/about": `<html><body><main><h1>About us</h1><p>${"We are a British bike brand founded in Oxfordshire. ".repeat(6)}</p></main></body></html>`,
      };
      const body = pages[req.url ?? ""];
      res.writeHead(body ? 200 : 404, { "content-type": req.url?.endsWith(".xml") ? "application/xml" : "text/html" });
      res.end(body ?? "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(reset);
  afterAll(async () => {
    server.close();
    await sql.end();
  });

  it("imports an mbox: threads, redaction, skipping, and a draft for a topic seen twice", async () => {
    const mbox = [
      email("<q1@x>", "jane@gmail.com", "Cracked frame", "Hi, my frame cracked. Call me on 07700 900123."),
      email("<a1@x>", "jo@whytebikes.com", "Re: Cracked frame", "Hi Jane,\n\nYes, send photos and the frame number.\n\nKind regards,\nJo\n01234 567890", "<q1@x>"),
      email("<q2@x>", "sam@yahoo.com", "Frame crack", "My rear triangle has a crack, covered?"),
      email("<a2@x>", "kim@whytebikes.com", "Re: Frame crack", "Yes it is. Send photos please.", "<q2@x>"),
      email("<q3@x>", "ann@gmail.com", "Creaking", "My bike creaks when pedalling"),
      email("<n1@x>", "news@shop.example", "Newsletter", "Our newsletter. Unsubscribe here."),
    ].join("");
    const key = "imports/2026-11-23/00000000-0000-4000-8000-000000000001";
    await writeLocalObject(`${IMPORT_BUCKET}/${key}`, Buffer.from(mbox), "application/octet-stream");
    const job = await createJob({ kind: "mbox", label: "Inbox", defaultAudience: "b2c", params: { key, size: Buffer.byteLength(mbox), offset: 0, staffDomains: ["whytebikes.com"] } }, { label: "Test" });
    const done = await finish(job.id);
    expect(done.status).toBe("done");

    const items = await sql`select external_id, status, topic, content from ingest_items order by external_id`;
    expect(items.map((i) => [i.external_id, i.status])).toEqual([
      ["thread:<n1@x>", "skipped"], // no reply from Whyte
      ["thread:<q1@x>", "drafted"],
      ["thread:<q2@x>", "drafted"],
      ["thread:<q3@x>", "skipped"], // no reply from Whyte
    ]);
    const thread = items.find((i) => i.external_id === "thread:<q1@x>")!;
    expect(thread.content).toBe("Customer:\nHi, my frame cracked. Call me on [phone].\n\nWhyte:\nHi [name],\n\nYes, send photos and the frame number.\n\nKind regards,");
    expect(JSON.stringify(items)).not.toMatch(/07700|gmail|Jane/);

    const [article] = await sql`select a.origin, v.title, v.body, v.author_label, v.status from kb_articles a join kb_article_versions v on v.id = a.working_version_id`;
    expect(article).toMatchObject({ origin: "ingestion", status: "draft", author_label: "Claude (from 2 emails)", title: "Is a cracked frame covered?" });
    expect(article!.body).toContain("## For the reviewer (delete before publishing)");
    const sources = await sql`select kind, reference from kb_sources order by reference`;
    expect(sources).toEqual([
      { kind: "email", reference: "<q1@x>" },
      { kind: "email", reference: "<q2@x>" },
    ]);
    // The uploaded export is deleted once read.
    expect(await (await objectStore(ORIGIN, IMPORT_BUCKET)).stat(key)).toBeNull();
  });

  it("imports a Zoho CSV and adds later cases to a topic already drafted", async () => {
    const csv = "Case Number,Subject,Description,Solution\n1,Creak,BB creaks,Regrease the BB\n2,Creaking,Creak from cranks,Clean and regrease\n";
    const key = "imports/2026-11-23/00000000-0000-4000-8000-000000000002";
    await writeLocalObject(`${IMPORT_BUCKET}/${key}`, Buffer.from(csv), "text/csv");
    const j1 = await createJob({ kind: "zoho_csv", label: "Zoho", defaultAudience: "b2c", params: { key } }, { label: "Test" });
    await finish(j1.id);
    expect((await sql`select count(*)::int as n from kb_articles`)[0]!.n).toBe(1);
    const [draft] = await sql`select v.author_label from kb_article_versions v`;
    expect(draft!.author_label).toBe("Claude (from 2 Zoho cases)");

    const key2 = "imports/2026-11-23/00000000-0000-4000-8000-000000000003";
    await writeLocalObject(`${IMPORT_BUCKET}/${key2}`, Buffer.from("Case Number,Subject,Description,Solution\n3,Creak again,Still creaks,Regrease it\n"), "text/csv");
    const j2 = await createJob({ kind: "zoho_csv", label: "Zoho 2", defaultAudience: "b2c", params: { key: key2 } }, { label: "Test" });
    await finish(j2.id);
    expect((await sql`select count(*)::int as n from kb_articles`)[0]!.n).toBe(1); // no duplicate article
    expect((await sql`select count(*)::int as n from kb_sources`)[0]!.n).toBe(3);
  });

  it("reads a sitemap and drafts only pages with support content", async () => {
    const job = await createJob({ kind: "web", label: "Site", defaultAudience: "both", params: { sitemapUrl: `${base}/sitemap.xml`, include: ["pages"] } }, { label: "Test" });
    const done = await finish(job.id);
    expect(done.status).toBe("done");
    expect((done.stats as { pagesFound: number }).pagesFound).toBe(2); // products and the off-site address excluded
    const items = await sql`select external_id, status from ingest_items order by external_id`;
    expect(items.map((i) => [i.external_id.replace(base, ""), i.status])).toEqual([
      ["/pages/about", "skipped"],
      ["/pages/warranty", "drafted"],
    ]);
    const [v] = await sql`select title, author_label from kb_article_versions`;
    expect(v).toMatchObject({ title: "Warranty: what's covered?", author_label: "Claude (from a whytebikes.com page)" });
  });

  it("queues resolved tickets, without internal notes, and drafts from one on request", async () => {
    const staff = { id: "00000000-0000-4000-8000-000000000009", label: "Jo" };
    await sql`insert into users (id, email, name, status) values (${staff.id}, 'jo@w.test', 'Jo', 'active')`;
    const t = await createTicket({ segment: "b2c", subject: "Creaky bike", body: "It creaks when I pedal hard", source: "form", contact: { email: "x@y.test", name: "X" }, firstMessageFrom: "customer", channel: "web" }, { label: "Form" });
    await addStaffMessage(t, { body: "Secret: customer is a pain", internal: true }, staff);
    await addStaffMessage(t, { body: "Regrease the bottom bracket shell and it'll stop.", internal: false }, staff);
    await updateTicket(t, { status: "resolved" }, staff);
    const [item] = await sql`select kind, external_id, status, content, audience from ingest_items`;
    expect(item).toMatchObject({ kind: "ticket", external_id: "WS-10001", status: "pending", audience: "b2c" });
    expect(item!.content).not.toContain("Secret");
    expect(item!.content).toContain("Whyte:\nRegrease");

    const articleId = await draftFromTicket(t.id);
    expect(articleId).toBeTruthy();
    const [a] = await sql`select a.origin, v.author_label from kb_articles a join kb_article_versions v on v.article_id = a.id`;
    expect(a).toMatchObject({ origin: "ticket", author_label: "Claude (from 1 tickets)" });
    await enqueueTicket(t.id); // already drafted: left alone
    expect((await sql`select status from ingest_items`)[0]!.status).toBe("drafted");
  });
});

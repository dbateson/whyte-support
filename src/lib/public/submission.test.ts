import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";
import { writeLocalObject } from "../storage";
import { issueUploads } from "../storage/attachments";
import { submitPublicTicket } from "./submission";

describe.skipIf(!TEST_DATABASE_URL)("public ticket submission", () => {
  const { sql, reset } = useTestDatabase();
  const ctx = { ip: "203.0.113.7", origin: "http://localhost:3000" };
  const claimKey = "k".repeat(40);
  const good = {
    segment: "b2c",
    category: "Warranty",
    name: "Jane Doe",
    email: "Jane@Example.com",
    summary: "Crack near the rear dropout",
    details: "Noticed a hairline crack after a ride last week.",
    productModel: "905, 2024",
    frameNumber: "WB12345",
    purchaseDate: "2025-09-14",
    purchasedFrom: "Ride Shop",
    claimKey,
  };

  beforeEach(reset);
  afterAll(async () => {
    await sql.end();
  });

  it("creates a ticket with the form's fields", async () => {
    const r = await submitPublicTicket(good, ctx);
    expect(r).toEqual({ ok: true, reference: "WS-10001", attached: 0 });
    const [t] = await sql`select t.segment, t.category, t.subject, t.source, t.frame_number, t.purchased_from, t.purchase_date::text, c.email from tickets t join contacts c on c.id = t.contact_id`;
    expect(t).toMatchObject({ segment: "b2c", category: "Warranty", subject: "Crack near the rear dropout", source: "form", frame_number: "WB12345", purchased_from: "Ride Shop", purchase_date: "2025-09-14", email: "jane@example.com" });
    const [m] = await sql`select author_type, channel, body from ticket_messages`;
    expect(m).toMatchObject({ author_type: "customer", channel: "web" });
  });

  it("explains what's wrong, field by field", async () => {
    const r = await submitPublicTicket({ ...good, email: "nope", details: "short", purchaseDate: "2999-01-01" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(Object.keys(r.fields ?? {}).sort()).toEqual(["details", "email", "purchaseDate"]);
  });

  it("needs a business name from dealers", async () => {
    const r = await submitPublicTicket({ ...good, segment: "b2b" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields?.company).toMatch(/business name/);
    const ok = await submitPublicTicket({ ...good, segment: "b2b", company: "Ride Shop Ltd", accountCode: "WB-0042" }, ctx);
    expect(ok.ok).toBe(true);
    const [c] = await sql`select company_name, account_code from contacts`;
    expect(c).toMatchObject({ company_name: "Ride Shop Ltd", account_code: "WB-0042" });
  });

  it("quietly drops honeypot submissions", async () => {
    const r = await submitPublicTicket({ ...good, website: "http://spam.example" }, ctx);
    expect(r.ok).toBe(true);
    expect((await sql`select count(*)::int as n from tickets`)[0]!.n).toBe(0);
  });

  it("limits submissions from one address", async () => {
    for (let i = 0; i < 8; i++) expect((await submitPublicTicket({ ...good, email: `r${i}@example.com` }, ctx)).ok).toBe(true);
    const ninth = await submitPublicTicket({ ...good, email: "r9@example.com" }, ctx);
    expect(ninth).toMatchObject({ ok: false, status: 429 });
    expect((await submitPublicTicket(good, { ...ctx, ip: "198.51.100.1" })).ok).toBe(true);
    const keys = await sql`select key from rate_limit_events limit 1`;
    expect(keys[0]!.key).not.toContain("203.0.113.7"); // stored hashed
  });

  it("attaches only uploads issued to this submission that actually arrived", async () => {
    const slots = await issueUploads(
      [
        { name: "../../crack.jpg", size: 5, type: "image/jpeg" },
        { name: "receipt.pdf", size: 5, type: "application/pdf" },
        { name: "virus.exe", size: 5, type: "application/x-msdownload" },
        { name: "huge.mov", size: 90_000_000, type: "video/quicktime" },
      ],
      claimKey,
      ctx.origin,
    );
    expect(slots.map((s) => ("error" in s ? "error" : "ok"))).toEqual(["ok", "ok", "error", "error"]);
    const [crack, receipt] = slots as { id: string; name: string }[];
    expect(crack!.name).toBe("crack.jpg"); // no path parts
    const [row] = await sql`select storage_key from ticket_attachments where id = ${crack!.id}`;
    expect(row!.storage_key).not.toContain("crack");
    await writeLocalObject(row!.storage_key, Buffer.from("hello"), "image/jpeg"); // only the first actually uploaded

    const someoneElse = await issueUploads([{ name: "theirs.jpg", size: 5, type: "image/jpeg" }], "z".repeat(40), ctx.origin);
    const theirs = someoneElse[0] as { id: string };
    const [theirRow] = await sql`select storage_key from ticket_attachments where id = ${theirs.id}`;
    await writeLocalObject(theirRow!.storage_key, Buffer.from("hello"), "image/jpeg");

    const r = await submitPublicTicket({ ...good, attachments: [crack!.id, receipt!.id, theirs.id] }, ctx);
    expect(r).toMatchObject({ ok: true, attached: 1 });
    const rows = await sql`select file_name, status, ticket_id is not null as linked from ticket_attachments order by file_name`;
    expect(rows.map((x) => [x.file_name, x.status, x.linked])).toEqual([
      ["crack.jpg", "attached", true],
      ["receipt.pdf", "pending", false],
      ["theirs.jpg", "pending", false],
    ]);
  });
});

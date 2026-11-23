import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeZoho } from "@/test/fake-zoho";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";

const { eraseSubject, exportSubject, findSubject, retentionSweep } = await import("./service");
const { createTicketWithMessage, addStaffMessage } = await import("../tickets/service");
const { setSecret } = await import("../secrets");
const { enableSync } = await import("../zoho/sync");

const actor = { label: "DPO" };
const origin = "http://localhost:3000";

describe.skipIf(!TEST_DATABASE_URL)("privacy requests", () => {
  const { sql, reset } = useTestDatabase();
  let zoho: FakeZoho;
  let restore: () => void;

  beforeEach(async () => {
    await reset();
    zoho = new FakeZoho();
    restore = zoho.install();
  });
  afterEach(() => restore());
  afterAll(async () => {
    await sql.end();
  });

  const seed = async () => {
    const { ticket } = await createTicketWithMessage(
      { segment: "b2c", subject: "Crack in my 905", body: "Hi, Jane here, frame WB123 cracked.", source: "form", category: "Warranty", frameNumber: "WB123", orderNumber: "W-1", contact: { email: "jane@example.com", name: "Jane Doe", phone: "07700 900123" }, firstMessageFrom: "customer", channel: "web" },
      { label: "Customer" },
    );
    await addStaffMessage(ticket, { body: "Thanks Jane, send photos please.", internal: true }, { id: undefined as never, label: "Jo" });
    const [s] = await sql`insert into chat_sessions (token_hash, segment, ticket_id) values ('h', 'b2c', ${ticket.id}) returning id`;
    await sql`insert into chat_messages (session_id, role, content) values (${s!.id}, 'user', 'my frame cracked')`;
    await sql`insert into ticket_attachments (ticket_id, storage_key, file_name, content_type, size_bytes, status, claim_hash) values (${ticket.id}, 'uploads/x/1', 'crack.jpg', 'image/jpeg', 10, 'attached', 'c')`;
    return ticket;
  };

  it("finds a person and exports everything held about them", async () => {
    await seed();
    const found = await findSubject(" JANE@example.com ");
    expect(found?.tickets.map((t) => t.number)).toEqual([10001]);
    const data = await exportSubject(found!.contact.id, actor);
    expect(data!.person).toMatchObject({ name: "Jane Doe", email: "jane@example.com", phone: "07700 900123" });
    expect(data!.tickets[0]).toMatchObject({ reference: "WS-10001", frameNumber: "WB123", files: [{ name: "crack.jpg", type: "image/jpeg", bytes: 10 }], chat: [{ from: "You", text: "my frame cracked" }] });
    expect(data!.tickets[0]!.messages.map((m) => [m.from, m.internal])).toEqual([["You", false], ["Jo", true]]);
    expect((await sql`select action, detail->>'fingerprint' as f from audit_log where action like 'gdpr.%'`)[0]).toMatchObject({ action: "gdpr.export" });
    expect(JSON.stringify(await sql`select detail from audit_log where action = 'gdpr.export'`)).not.toContain("jane@");
  });

  it("erases a person: details, messages, files and chats; statistics stay", async () => {
    const ticket = await seed();
    const found = await findSubject("jane@example.com");
    const r = await eraseSubject(found!.contact.id, actor, origin, { askZoho: true });
    expect(r).toEqual({ tickets: 1, files: 1, zoho: "not-linked", zohoCases: [] });
    expect(await sql`select name, email, phone, anonymised_at is not null as erased from contacts`).toEqual([{ name: "", email: null, phone: null, erased: true }]);
    expect(await sql`select subject, frame_number, order_number, category, segment, erased_at is not null as erased from tickets`).toEqual([
      { subject: "[Erased on request]", frame_number: null, order_number: null, category: "Warranty", segment: "b2c", erased: true },
    ]);
    expect((await sql`select distinct body from ticket_messages`).map((m) => m.body)).toEqual(["[Erased on request]"]);
    expect((await sql`select count(*)::int as n from chat_sessions`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int as n from ticket_attachments`)[0]!.n).toBe(0);
    // Search no longer finds the old words.
    expect((await sql`select count(*)::int as n from tickets where search_vector @@ plainto_tsquery('english', 'cracked frame')`)[0]!.n).toBe(0);
    expect(await findSubject("jane@example.com")).toBeNull();
    expect(await eraseSubject(found!.contact.id, actor, origin, { askZoho: true })).toBeNull();
    expect(ticket.id).toBeTruthy();
  });

  it("asks Zoho to erase its copy with a task", async () => {
    await setSecret("zoho.client_id", "c", actor);
    await setSecret("zoho.client_secret", "s", actor);
    await setSecret("zoho.refresh_token", "r", actor);
    await enableSync(actor);
    await seed();
    await sql`update contacts set zoho_contact_id = '777'`;
    await sql`update tickets set zoho_case_number = '5001'`;
    const found = await findSubject("jane@example.com");
    const r = await eraseSubject(found!.contact.id, actor, origin, { askZoho: true });
    expect(r).toMatchObject({ zoho: "task", zohoCases: ["5001"] });
    const task = zoho.calls.find((c) => c.path === "/Tasks")!;
    expect(task.body).toMatchObject({ data: [{ Subject: "Erase personal data (UK GDPR request)", Who_Id: { id: "777" } }], trigger: [] });
    expect(JSON.stringify(task.body)).not.toContain("jane");
  });

  it("erases closed tickets after the retention period, and people with nothing left", async () => {
    await seed();
    await sql`update tickets set status = 'closed', updated_at = now() - interval '7 years'`;
    await sql`update contacts set updated_at = now() - interval '7 years'`;
    expect(await retentionSweep(origin)).toEqual({ tickets: 1, contacts: 1 });
    expect((await sql`select subject from tickets`)[0]!.subject).toBe("[Erased: retention period ended]");
    expect((await sql`select email from contacts`)[0]!.email).toBeNull();
    expect(await retentionSweep(origin)).toEqual({ tickets: 0, contacts: 0 });
  });
});

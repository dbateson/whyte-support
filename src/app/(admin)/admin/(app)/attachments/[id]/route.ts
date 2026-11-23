import { eq } from "drizzle-orm";
import { requireStaff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { log } from "@/lib/logger";
import { selfOrigin } from "@/lib/public/cors";
import { objectStore } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Downloads an attachment: checks the ticket's segment, then redirects to a 60-second signed link. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff("tickets.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const [row] = await db()
    .select({ a: schema.ticketAttachments, segment: schema.tickets.segment })
    .from(schema.ticketAttachments)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketAttachments.ticketId))
    .where(eq(schema.ticketAttachments.id, id));
  if (!row || row.a.status !== "attached" || !staff.can("tickets.view", row.segment)) return new Response("Not found", { status: 404 });
  try {
    const url = await (await objectStore(selfOrigin(req))).downloadUrl(row.a.storageKey, row.a.fileName, 60);
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (err) {
    log.error("Attachment download failed", { err, id });
    return new Response("The file couldn't be fetched from storage.", { status: 502 });
  }
}

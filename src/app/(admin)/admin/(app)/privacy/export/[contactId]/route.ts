import { requireStaff } from "@/lib/auth/session";
import { exportSubject } from "@/lib/privacy/service";

export const dynamic = "force-dynamic";

/** Everything held about a person, as a JSON file (right of access and portability). The download is recorded in the audit log. */
export async function GET(_: Request, { params }: { params: Promise<{ contactId: string }> }) {
  const staff = await requireStaff("gdpr.process");
  const { contactId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(contactId)) return new Response("Not found", { status: 404 });
  const data = await exportSubject(contactId, { id: staff.id, label: staff.name });
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="whyte-support-data-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}

import type { Metadata } from "next";
import { count, desc } from "drizzle-orm";
import { DataTable, PageHeader, Stack, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { formatDateTime } from "@/lib/tickets/format";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE = 50;
type Row = typeof schema.auditLog.$inferSelect;

const ACTIONS: Record<string, string> = {
  "secret.set": "Saved an integration key",
  "secret.clear": "Cleared an integration key",
  "secret.reencrypt": "Re-encrypted keys",
  "settings.update": "Changed settings",
  "user.invite": "Invited a user",
  "user.accept_invite": "Accepted an invitation",
  "user.reset_requested": "Asked to reset a password",
  "user.reset_password": "Reset their password",
  "user.roles": "Changed someone's roles",
  "user.disable": "Disabled a user",
  "user.enable": "Enabled a user",
  "user.mfa_reset": "Reset someone's authenticator",
  "user.mfa_enabled": "Turned on two-step sign-in",
  "role.create": "Created a role",
  "role.update": "Changed a role",
  "role.delete": "Deleted a role",
};

function summarise(detail: unknown): string {
  if (!detail || typeof detail !== "object" || Object.keys(detail).length === 0) return "";
  return Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => {
      if (v && typeof v === "object" && "to" in v) return `${k}: ${String((v as { to: unknown }).to) || "(blank)"}`;
      return `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`;
    })
    .join("; ");
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireStaff("audit.view");
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db().select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(PAGE).offset((page - 1) * PAGE),
    db().select({ total: count() }).from(schema.auditLog),
  ]);
  const columns: DataTableColumn<Row>[] = [
    { key: "at", header: "When", cell: (r) => formatDateTime(r.at) },
    { key: "who", header: "Who", cell: (r) => r.actorLabel },
    { key: "action", header: "What", cell: (r) => ACTIONS[r.action] ?? r.action },
    { key: "target", header: "On", cell: (r) => r.target ?? "" },
    { key: "detail", header: "Detail", cell: (r) => summarise(r.detail) },
  ];
  return (
    <Stack>
      <PageHeader title="Audit log" description="Changes to settings, keys, users and roles. Key values are never recorded." />
      <DataTable label="Audit log" columns={columns} rows={rows} rowKey={(r) => String(r.id)} total={total} page={page} pageSize={PAGE} pageHref={(p) => `/admin/settings/audit${p > 1 ? `?page=${p}` : ""}`} noun="entries" />
    </Stack>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Button, DataTable, PageHeader, Stack, Status, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { listUsers } from "@/lib/auth/users";
import { formatAgo } from "@/lib/tickets/format";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listUsers>>[number];

const STATUS = {
  active: { tone: "success", label: "Active" },
  invited: { tone: "warning", label: "Invited" },
  disabled: { tone: "neutral", label: "Disabled" },
} as const;

export default async function UsersPage() {
  await requireStaff("users.manage");
  const users = await listUsers();
  const columns: DataTableColumn<Row>[] = [
    { key: "name", header: "Name", cell: (u) => <Link href={`/admin/settings/users/${u.id}`}>{u.name}</Link> },
    { key: "email", header: "Email", cell: (u) => u.email },
    { key: "roles", header: "Roles", cell: (u) => u.roles.map((r) => r.name).join(", ") || "None" },
    { key: "status", header: "Status", cell: (u) => <Status tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Status> },
    { key: "mfa", header: "Two-step", cell: (u) => (u.totpEnabledAt ? "On" : "Not set up") },
    { key: "last", header: "Last sign-in", cell: (u) => (u.lastLoginAt ? formatAgo(u.lastLoginAt) : "Never") },
  ];
  return (
    <Stack>
      <PageHeader title="Users" description="Staff who can sign in. What each person can see and do comes from their roles." actions={<Button href="/admin/settings/users/new">Invite someone</Button>} />
      <DataTable label="Users" columns={columns} rows={users} rowKey={(u) => u.id} total={users.length} noun="users" />
    </Stack>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Button, DataTable, PageHeader, Stack, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { listRoles } from "@/lib/auth/users";

export const metadata: Metadata = { title: "Roles" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listRoles>>[number];

export default async function RolesPage() {
  await requireStaff("users.manage");
  const roles = await listRoles();
  const columns: DataTableColumn<Row>[] = [
    { key: "name", header: "Role", cell: (r) => <Link href={`/admin/settings/roles/${r.id}`}>{r.name}</Link> },
    { key: "description", header: "What it's for", cell: (r) => r.description },
    { key: "segments", header: "Segments", cell: (r) => r.segments.map((s) => s.toUpperCase()).join(", ") },
    { key: "permissions", header: "Permissions", numeric: true, cell: (r) => r.permissions.length },
    { key: "members", header: "People", numeric: true, cell: (r) => r.members },
  ];
  return (
    <Stack>
      <PageHeader title="Roles" description="A role is a set of permissions over B2C, B2B or both. A person can have several." actions={<Button href="/admin/settings/roles/new">New role</Button>} />
      <DataTable label="Roles" columns={columns} rows={roles} rowKey={(r) => r.id} total={roles.length} noun="roles" />
    </Stack>
  );
}

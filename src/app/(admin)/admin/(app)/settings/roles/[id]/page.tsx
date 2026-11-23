import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Breadcrumb, Button, PageHeader, Stack } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { listRoles } from "@/lib/auth/users";
import { deleteRoleAction } from "../../actions";
import { RoleForm } from "../RoleForm";

export const metadata: Metadata = { title: "Role" };
export const dynamic = "force-dynamic";

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff("users.manage");
  const { id } = await params;
  const role = (await listRoles()).find((r) => r.id === id);
  if (!role) notFound();
  const locked = role.isSystem && role.name === "Admin";
  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Roles", href: "/admin/settings/roles" }, { label: role.name }]} />}
        title={role.name}
        description={`${role.members} ${role.members === 1 ? "person has" : "people have"} this role.`}
      />
      <div className="ds-width-8">
        <Stack>
          {locked && <Alert tone="info">Admin always has every permission in both segments, so no one can lock everyone out.</Alert>}
          <RoleForm role={role} />
          {!role.isSystem && (
            <ActionForm action={deleteRoleAction} label="Delete role">
              <input type="hidden" name="id" value={role.id} />
              <div className="ds-inline">
                <Button type="submit" variant="secondary">Delete role</Button>
              </div>
            </ActionForm>
          )}
        </Stack>
      </div>
    </Stack>
  );
}

import type { Metadata } from "next";
import { Breadcrumb, PageHeader, Stack } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { RoleForm } from "../RoleForm";

export const metadata: Metadata = { title: "New role" };

export default async function NewRolePage() {
  await requireStaff("users.manage");
  return (
    <Stack>
      <PageHeader breadcrumb={<Breadcrumb items={[{ label: "Roles", href: "/admin/settings/roles" }, { label: "New role" }]} />} title="New role" />
      <div className="ds-width-8">
        <RoleForm />
      </div>
    </Stack>
  );
}

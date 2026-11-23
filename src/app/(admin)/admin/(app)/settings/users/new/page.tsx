import type { Metadata } from "next";
import { Breadcrumb, Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { listRoles } from "@/lib/auth/users";
import { inviteUserAction } from "../../actions";
import { RoleChoices } from "../RoleChoices";

export const metadata: Metadata = { title: "Invite someone" };

export default async function InvitePage() {
  await requireStaff("users.manage");
  const roles = await listRoles();
  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Users", href: "/admin/settings/users" }, { label: "Invite someone" }]} />}
        title="Invite someone"
        description="They'll get a link to set a password, then set up an authenticator app at first sign-in."
      />
      <div className="ds-width-8">
        <ActionForm action={inviteUserAction} resetOnSuccess label="Invite someone">
          <TextField label="Email" name="email" type="email" autoComplete="off" required />
          <TextField label="Name" name="name" autoComplete="off" required />
          <RoleChoices roles={roles} checked={roles.filter((r) => r.name === "Agent").map((r) => r.id)} />
          <div className="ds-inline">
            <Button type="submit">Send invitation</Button>
          </div>
        </ActionForm>
      </div>
    </Stack>
  );
}

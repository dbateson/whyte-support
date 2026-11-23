import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumb, Button, CardGrid, DescriptionList, GridItem, PageHeader, Panel, Stack } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { getUser, listRoles } from "@/lib/auth/users";
import { formatDateTime } from "@/lib/tickets/format";
import { saveUserRolesAction, userAccessAction } from "../../actions";
import { RoleChoices } from "../RoleChoices";

export const metadata: Metadata = { title: "User" };
export const dynamic = "force-dynamic";

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff("users.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [user, roles] = await Promise.all([getUser(id), listRoles()]);
  if (!user) notFound();
  const status = { active: "Active", invited: "Invited: hasn't set a password", disabled: "Disabled: can't sign in" }[user.status];
  return (
    <Stack>
      <PageHeader breadcrumb={<Breadcrumb items={[{ label: "Users", href: "/admin/settings/users" }, { label: user.name }]} />} title={user.name} description={user.email} />
      <CardGrid>
        <GridItem span={8}>
          <Panel title="Roles">
            <ActionForm action={saveUserRolesAction} label="Roles">
              <input type="hidden" name="userId" value={user.id} />
              <RoleChoices roles={roles} checked={user.roles.map((r) => r.id)} />
              <div className="ds-inline">
                <Button type="submit">Save roles</Button>
              </div>
            </ActionForm>
          </Panel>
        </GridItem>
        <GridItem span={4}>
          <Panel title="Access">
            <Stack>
              <DescriptionList
                items={[
                  { term: "Status", detail: status },
                  { term: "Two-step sign-in", detail: user.totpEnabledAt ? `On since ${formatDateTime(user.totpEnabledAt)}` : "Not set up" },
                  { term: "Last sign-in", detail: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never" },
                ]}
              />
              <ActionForm action={userAccessAction} label="Change access">
                <input type="hidden" name="userId" value={user.id} />
                <div className="ds-inline">
                  {user.status === "invited" && <Button type="submit" name="intent" value="resend" size="small" variant="secondary">New invitation link</Button>}
                  {user.totpEnabledAt && <Button type="submit" name="intent" value="reset-mfa" size="small" variant="secondary">Reset authenticator</Button>}
                  {user.status === "disabled" ? (
                    <Button type="submit" name="intent" value="enable" size="small" variant="secondary">Enable</Button>
                  ) : (
                    user.id !== staff.id && <Button type="submit" name="intent" value="disable" size="small" variant="secondary">Disable</Button>
                  )}
                </div>
              </ActionForm>
            </Stack>
          </Panel>
        </GridItem>
      </CardGrid>
    </Stack>
  );
}

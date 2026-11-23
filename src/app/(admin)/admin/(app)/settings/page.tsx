import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/session";

/** Settings is a section, not a page: go to the first sub-page this person can use. */
export default async function SettingsIndex() {
  const staff = await requireStaff();
  if (staff.can("settings.manage")) redirect("/admin/settings/integrations");
  if (staff.can("users.manage")) redirect("/admin/settings/users");
  if (staff.can("audit.view")) redirect("/admin/settings/audit");
  redirect("/admin/no-access");
}

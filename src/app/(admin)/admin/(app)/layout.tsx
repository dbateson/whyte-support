import type { ReactNode } from "react";
import { AppShell } from "@whyte/design-system";
import { AdminNav } from "@/components/AdminNav";
import { requireStaff } from "@/lib/auth/session";
import { signOut } from "../(auth)/actions";

/** Every page in here needs a signed-in, two-step-verified staff member. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  const nav = {
    tickets: staff.can("tickets.view"),
    kb: staff.can("kb.view"),
    kbEdit: staff.can("kb.edit"),
    chat: staff.can("chat.view"),
    analytics: staff.can("analytics.view"),
    settings: staff.can("settings.manage"),
    users: staff.can("users.manage"),
    audit: staff.can("audit.view"),
    privacy: staff.can("gdpr.process"),
  };
  return (
    <AppShell sidebar={<AdminNav show={nav} name={staff.name} email={staff.email} detail={staff.roleNames.join(", ") || "No role"} signOut={signOut} />}>
      {children}
    </AppShell>
  );
}

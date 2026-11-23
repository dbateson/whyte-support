import type { ReactNode } from "react";
import { AppShell } from "@whyte/design-system";
import { AdminNav } from "@/components/AdminNav";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AppShell sidebar={<AdminNav />}>{children}</AppShell>;
}

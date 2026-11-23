"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu, SideNav, type SideNavItem } from "@whyte/design-system/client";
import logo from "@whyte/design-system/logos/whyte-lockup-horizontal.svg";

export interface NavVisibility {
  tickets: boolean;
  kb: boolean;
  kbEdit: boolean;
  chat: boolean;
  analytics: boolean;
  settings: boolean;
  users: boolean;
  audit: boolean;
  privacy: boolean;
}

function isCurrent(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  // Articles is the knowledge base's list and its article pages, not its other sub-pages.
  if (href === "/admin/kb") return pathname === "/admin/kb" || pathname.startsWith("/admin/kb/articles");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The side menu: only the sections the signed-in person's roles allow. */
export function AdminNav({
  show,
  name,
  email,
  detail,
  signOut,
}: {
  show: NavVisibility;
  name: string;
  email: string;
  detail: string;
  signOut: () => Promise<void>;
}) {
  const pathname = usePathname() ?? "";
  const settings = [
    show.settings && { href: "/admin/settings/integrations", label: "Integrations" },
    show.settings && { href: "/admin/settings/general", label: "General" },
    show.settings && { href: "/admin/settings/zoho", label: "Zoho CRM" },
    show.users && { href: "/admin/settings/users", label: "Users" },
    show.users && { href: "/admin/settings/roles", label: "Roles" },
    show.audit && { href: "/admin/settings/audit", label: "Audit log" },
    show.privacy && { href: "/admin/privacy", label: "Privacy requests" },
  ].filter(Boolean) as { href: string; label: string }[];
  const sections = [
    { href: "/admin", label: "Overview" },
    show.tickets && { href: "/admin/tickets", label: "Tickets" },
    show.kb && {
      href: "/admin/kb/section",
      label: "Knowledge base",
      children: [
        { href: "/admin/kb", label: "Articles" },
        { href: "/admin/kb/review", label: "Review" },
        { href: "/admin/kb/search", label: "Test search" },
        ...(show.kbEdit ? [{ href: "/admin/kb/import", label: "Import" }] : []),
      ],
    },
    show.chat && { href: "/admin/chat", label: "Chatbot" },
    show.analytics && { href: "/admin/analytics", label: "Analytics" },
    settings.length > 0 && { href: "/admin/settings", label: "Settings", children: settings },
  ].filter(Boolean) as (SideNavItem & { children?: { href: string; label: string }[] })[];
  const items: SideNavItem[] = sections.map((s) => ({
    ...s,
    current: !s.children && isCurrent(pathname, s.href),
    children: s.children?.map((c) => ({ ...c, current: isCurrent(pathname, c.href) })),
  }));
  return (
    <SideNav
      brand={<Image src={logo} alt="Whyte" width={140} height={32} priority />}
      items={items}
      renderLink={({ children, ...props }) => <Link {...props}>{children}</Link>}
      footer={<AccountMenu name={name} email={email} detail={detail} items={[{ label: "Sign out", onSelect: () => void signOut() }]} />}
    />
  );
}

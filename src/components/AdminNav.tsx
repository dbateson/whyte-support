"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SideNav, type SideNavItem } from "@whyte/design-system/client";
import logo from "@whyte/design-system/logos/whyte-lockup-horizontal.svg";

const SECTIONS: { href: string; label: string }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/tickets", label: "Tickets" },
  { href: "/admin/kb", label: "Knowledge base" },
  { href: "/admin/chat", label: "Chatbot" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/settings", label: "Settings" },
];

function isCurrent(pathname: string, href: string) {
  return href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav() {
  const pathname = usePathname() ?? "";
  const items: SideNavItem[] = SECTIONS.map((s) => ({ ...s, current: isCurrent(pathname, s.href) }));
  return (
    <SideNav
      brand={<Image src={logo} alt="Whyte" width={140} height={32} priority />}
      items={items}
      renderLink={({ children, ...props }) => <Link {...props}>{children}</Link>}
    />
  );
}

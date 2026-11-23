import type { ReactNode } from "react";
import Image from "next/image";
import { Stack, TopBar } from "@whyte/design-system";
import logo from "@whyte/design-system/logos/whyte-lockup-horizontal.svg";

/** Sign-in pages: the brand bar and one narrow column, no side menu. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <Stack gap="large">
      <TopBar brand={<Image src={logo} alt="Whyte" width={140} height={32} priority />} product="Support" />
      <main className="ds-container">
        <div className="ds-width-4">{children}</div>
      </main>
    </Stack>
  );
}

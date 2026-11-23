import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@whyte/design-system/styles.css";
// Internal tools set Inter throughout; Delight stays for customer-facing pages.
import "@whyte/design-system/themes/app.css";

export const metadata: Metadata = {
  title: { default: "Whyte Support admin", template: "%s · Whyte Support admin" },
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="ds-body">{children}</body>
    </html>
  );
}

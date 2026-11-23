import type { Metadata } from "next";
import type { ReactNode } from "react";
// Customer-facing: the brand typography (Delight for headings), so no app theme.
import "@whyte/design-system/styles.css";

export const metadata: Metadata = {
  title: { default: "Whyte Bikes support", template: "%s · Whyte Bikes support" },
};

export default function PublicRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="ds-body">{children}</body>
    </html>
  );
}

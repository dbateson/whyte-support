import type { Metadata } from "next";
import Image from "next/image";
import { PageHeader, Stack, TopBar } from "@whyte/design-system";
import logo from "@whyte/design-system/logos/whyte-lockup-horizontal.svg";
import { SupportForm } from "@/components/support-form/SupportForm";

export const metadata: Metadata = {
  title: "Contact support",
  description: "Warranty claims, technical help, orders and dealer enquiries for Whyte Bikes.",
};

export default function SupportHome() {
  return (
    <Stack gap="large">
      <TopBar brand={<Image src={logo} alt="Whyte" width={140} height={32} priority />} product="Support" />
      <main className="ds-container">
        <div className="ds-width-8">
          <Stack gap="large">
            <PageHeader title="How can we help?" description="Tell us what's going on and we'll reply by email. Warranty claims, technical questions, orders and dealer enquiries all start here." />
            <SupportForm />
          </Stack>
        </div>
      </main>
    </Stack>
  );
}

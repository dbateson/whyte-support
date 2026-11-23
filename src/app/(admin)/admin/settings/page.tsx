import type { Metadata } from "next";
import { ComingInPhase } from "@/components/ComingInPhase";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <ComingInPhase title="Settings" phase={1}>
      Users and roles, and the integration keys for Anthropic, Voyage, Zoho, email, Shopify and Turnstile, stored encrypted.
    </ComingInPhase>
  );
}

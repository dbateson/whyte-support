import type { Metadata } from "next";
import { ComingInPhase } from "@/components/ComingInPhase";

export const metadata: Metadata = { title: "Knowledge base" };

export default function Page() {
  return (
    <ComingInPhase title="Knowledge base" phase={3}>
      Articles, drafts awaiting approval and ingestion from emails, Zoho and whytebikes.com.
    </ComingInPhase>
  );
}

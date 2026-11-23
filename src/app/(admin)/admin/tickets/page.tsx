import type { Metadata } from "next";
import { ComingInPhase } from "@/components/ComingInPhase";

export const metadata: Metadata = { title: "Tickets" };

export default function Page() {
  return (
    <ComingInPhase title="Tickets" phase={1}>
      The B2C and B2B ticket queues, threads and search.
    </ComingInPhase>
  );
}

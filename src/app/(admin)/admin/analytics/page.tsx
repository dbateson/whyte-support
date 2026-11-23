import type { Metadata } from "next";
import { ComingInPhase } from "@/components/ComingInPhase";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return (
    <ComingInPhase title="Analytics" phase={6}>
      Trends, automation candidates and customer experience gaps.
    </ComingInPhase>
  );
}

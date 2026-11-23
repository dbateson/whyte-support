import type { Metadata } from "next";
import { ComingInPhase } from "@/components/ComingInPhase";

export const metadata: Metadata = { title: "Chatbot" };

export default function Page() {
  return (
    <ComingInPhase title="Chatbot" phase={4}>
      Conversations, the sources behind every answer, and escalations.
    </ComingInPhase>
  );
}

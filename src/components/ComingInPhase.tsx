import { EmptyState, PageHeader } from "@whyte/design-system";

/** Placeholder for an admin section that arrives in a later phase. */
export function ComingInPhase({ title, phase, children }: { title: string; phase: number; children: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title={`Arrives in Phase ${phase}`}>{children}</EmptyState>
    </>
  );
}

import { EmptyState } from "@whyte/design-system";

// The support form arrives in Phase 2. The brand page frame (site header and
// footer) is a design-system gap; until it exists this page stays bare.
export default function SupportHome() {
  return (
    <main>
      <EmptyState title="Whyte Bikes support" headingLevel={2}>
        Our support form is coming soon.
      </EmptyState>
    </main>
  );
}

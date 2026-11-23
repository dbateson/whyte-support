import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@whyte/design-system";

export const metadata: Metadata = { title: "No access" };

export default function NoAccessPage() {
  return (
    <>
      <PageHeader title="No access" />
      <EmptyState title="Your role doesn't include this page">
        Ask an admin to add the permission to one of your roles.
      </EmptyState>
    </>
  );
}

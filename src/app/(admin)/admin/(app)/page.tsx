import type { Metadata } from "next";
import Link from "next/link";
import { CardGrid, EmptyState, GridItem, MetricCard, PageHeader, Stack } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { queueCounts } from "@/lib/tickets/queries";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const staff = await requireStaff();
  const segments = staff.segmentsFor("tickets.view");
  if (!staff.can("tickets.view")) {
    return (
      <Stack>
        <PageHeader title={`Hello, ${staff.name.split(" ")[0]}`} />
        <EmptyState title="Nothing to show yet">Your roles don&apos;t include the ticket queue.</EmptyState>
      </Stack>
    );
  }
  const counts = await queueCounts({ id: staff.id, segments });
  const link = ({ children, ...p }: { href: string; className?: string; children: React.ReactNode }) => <Link {...p}>{children}</Link>;
  const scope = segments.length === 2 ? "B2C and B2B" : segments[0]!.toUpperCase();
  return (
    <Stack>
      <PageHeader title="Overview" description={`The ticket queue, ${scope}.`} />
      <CardGrid label="Ticket queue">
        <GridItem span={3}>
          <MetricCard title="Open tickets" value={counts.open.toLocaleString("en-GB")} href="/admin/tickets" renderLink={link} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Waiting on Whyte" value={counts.waitingOnUs.toLocaleString("en-GB")} href="/admin/tickets?status=new,open,pending_internal" renderLink={link} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Unassigned" value={counts.unassigned.toLocaleString("en-GB")} href="/admin/tickets?assignee=unassigned" renderLink={link} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Assigned to me" value={counts.mine.toLocaleString("en-GB")} href="/admin/tickets?assignee=me" renderLink={link} />
        </GridItem>
      </CardGrid>
    </Stack>
  );
}

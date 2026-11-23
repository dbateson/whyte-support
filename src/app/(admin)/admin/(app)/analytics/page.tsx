import type { Metadata } from "next";
import Link from "next/link";
import { BarList, CardGrid, ChartCard, DataTable, EmptyState, GridItem, MetricCard, PageHeader, Panel, Stack, type DataTableColumn } from "@whyte/design-system";
import { ColumnChart, DonutChart, LineChartCard } from "@whyte/design-system/client";
import { AnalyticsFilter } from "@/components/AnalyticsFilter";
import { breakdowns, experience, hours, parseRange, previousRange, summary, topicAdvice, topics, unansweredQuestions, uncovered, volume, type Topic } from "@/lib/analytics/queries";
import { requireStaff } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const SOURCE: Record<string, string> = { form: "Support form", chat: "From the assistant", email: "Email", staff: "Logged by staff", zoho: "Zoho CRM" };
const change = (now: number | null, before: number | null) => (now == null || before == null || before === 0 ? undefined : ((now - before) / before) * 100);
const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);

type Question = Awaited<ReturnType<typeof unansweredQuestions>>[number];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff("analytics.view");
  const range = parseRange(await searchParams);
  // Figures are for everyone with analytics; customers' own words only for segments this person may read chats in.
  const chatSegments = staff.segmentsFor("chat.view");
  const questionRange = range.segment ? (chatSegments.includes(range.segment) ? range : null) : chatSegments.length === 2 ? range : chatSegments.length === 1 ? { ...range, segment: chatSegments[0] } : null;
  const [now, before, vol, parts, topicRows, questions, gaps, exp] = await Promise.all([
    summary(range),
    summary(previousRange(range)),
    volume(range),
    breakdowns(range),
    topics(range),
    questionRange ? unansweredQuestions(questionRange) : Promise.resolve([]),
    uncovered(range),
    experience(range),
  ]);
  const vs = { label: "vs previous period" };

  const topicColumns: DataTableColumn<Topic>[] = [
    { key: "article", header: "Topic (article)", cell: (t) => <Link href={`/admin/kb/articles/${t.articleId}`}>{t.title}</Link> },
    { key: "tickets", header: "Tickets", cell: (t) => t.tickets },
    { key: "chats", header: "Answered in chat", cell: (t) => t.chats },
    { key: "escalated", header: "Then asked for the team", cell: (t) => t.escalated },
    { key: "unhelpful", header: "Rated unhelpful", cell: (t) => t.unhelpful },
    { key: "advice", header: "Suggests", cell: (t) => topicAdvice(t) },
  ];
  const questionColumns: DataTableColumn<Question>[] = [
    { key: "q", header: "Question", cell: (q) => q.question.slice(0, 160) },
    { key: "n", header: "Times asked", cell: (q) => q.times },
    { key: "last", header: "Last asked", cell: (q) => new Date(q.last).toLocaleDateString("en-GB") },
  ];

  return (
    <Stack>
      <PageHeader
        title="Analytics"
        description="Tickets and chats in the chosen dates, including history imported from Zoho. Use it to see what customers need, what the assistant could take on, and where people wait."
        actions={<AnalyticsFilter from={range.from} to={range.to} segment={range.segment} />}
      />

      <CardGrid label="Headline figures">
        <GridItem span={4}>
          <MetricCard title="Tickets" value={now.tickets.toLocaleString("en-GB")} delta={change(now.tickets, before.tickets) == null ? undefined : { ...vs, value: change(now.tickets, before.tickets)!, goodWhen: "down" }} trend={vol.data.map((d) => d.b2c + d.b2b)} />
        </GridItem>
        <GridItem span={4}>
          <MetricCard title="Median first reply" value={hours(now.firstResponseHours)} delta={change(now.firstResponseHours, before.firstResponseHours) == null ? undefined : { ...vs, value: change(now.firstResponseHours, before.firstResponseHours)!, goodWhen: "down" }} />
        </GridItem>
        <GridItem span={4}>
          <MetricCard title="Replied to within 24 hours" value={pct(now.respondedWithinDay)} delta={now.respondedWithinDay == null || before.respondedWithinDay == null ? undefined : { ...vs, value: (now.respondedWithinDay - before.respondedWithinDay) * 100, unit: "pt" }} />
        </GridItem>
        <GridItem span={4}>
          <MetricCard title="Median time to resolve" value={hours(now.resolutionHours)} delta={change(now.resolutionHours, before.resolutionHours) == null ? undefined : { ...vs, value: change(now.resolutionHours, before.resolutionHours)!, goodWhen: "down" }} />
        </GridItem>
        <GridItem span={4}>
          <MetricCard title="Chats answered by the assistant" value={pct(now.answeredByBot)} delta={now.answeredByBot == null || before.answeredByBot == null ? undefined : { ...vs, value: (now.answeredByBot - before.answeredByBot) * 100, unit: "pt" }} trend={vol.data.map((d) => d.chats)} />
        </GridItem>
        <GridItem span={4}>
          <MetricCard title="Questions the assistant couldn't answer" value={now.unanswered.toLocaleString("en-GB")} delta={change(now.unanswered, before.unanswered) == null ? undefined : { ...vs, value: change(now.unanswered, before.unanswered)!, goodWhen: "down" }} />
        </GridItem>
      </CardGrid>

      <LineChartCard
        title="Tickets and chats"
        subtitle={`Per ${vol.granularity}`}
        dates={vol.data.map((d) => d.bucket)}
        granularity={vol.granularity}
        series={[
          ...(range.segment !== "b2b" ? [{ id: "b2c", label: "Rider tickets", values: vol.data.map((d) => d.b2c) }] : []),
          ...(range.segment !== "b2c" ? [{ id: "b2b", label: "Dealer tickets", values: vol.data.map((d) => d.b2b) }] : []),
          { id: "chats", label: "Chats", values: vol.data.map((d) => d.chats), muted: true },
        ]}
      />

      <CardGrid label="Breakdowns">
        <GridItem span={6}>
          <ChartCard title="By category" subtitle="Tickets">
            {parts.category.length ? <BarList label="Tickets by category" items={parts.category} /> : <EmptyState title="No tickets in these dates" />}
          </ChartCard>
        </GridItem>
        <GridItem span={6}>
          <ChartCard title="By bike" subtitle="Tickets that named a model">
            {parts.product.length ? <BarList label="Tickets by bike model" items={parts.product} /> : <EmptyState title="No models given" />}
          </ChartCard>
        </GridItem>
        <GridItem span={6}>
          <ChartCard title="How tickets arrive">
            {parts.source.length ? <DonutChart label="Tickets by source" items={parts.source.map((s) => ({ label: SOURCE[s.label] ?? s.label, value: s.value }))} totalLabel="tickets" /> : <EmptyState title="No tickets" />}
          </ChartCard>
        </GridItem>
        <GridItem span={6}>
          <ChartCard title="Median hours to resolve" subtitle="Categories with at least 3 resolved tickets">
            {parts.resolution.length ? (
              <ColumnChart label="Median hours to resolve by category" items={parts.resolution.map((p) => ({ label: p.label, value: Math.round(p.value * 10) / 10 }))} format={{ digits: 1 }} categoryLabel="Category" />
            ) : (
              <EmptyState title="Not enough resolved tickets yet" />
            )}
          </ChartCard>
        </GridItem>
      </CardGrid>

      <Panel title="Automation candidates" description="Each published article as a topic: tickets about it (its title's words all appear) and chats the assistant answered from it. Topics with many tickets and few chats are the ones to point customers at.">
        <DataTable label="Topics" columns={topicColumns} rows={topicRows} rowKey={(t) => t.articleId} total={topicRows.length} noun="topics" empty={<EmptyState title="No topics yet">Publish articles and they appear here.</EmptyState>} />
      </Panel>

      <CardGrid label="Gaps">
        <GridItem span={8}>
          <Panel
            title="Questions the assistant couldn't answer"
            description={questionRange ? `Most asked first. Each is a candidate for a new article.${questionRange.segment && !range.segment ? ` ${questionRange.segment === "b2b" ? "Dealer" : "Rider"} chats only: the ones your role can read.` : ""}` : "Your role can't read customers' chats, so these aren't shown."}
          >
            <DataTable label="Unanswered questions" columns={questionColumns} rows={questions} rowKey={(q) => q.question} total={questions.length} noun="questions" empty={<EmptyState title="None in these dates" />} />
          </Panel>
        </GridItem>
        <GridItem span={4}>
          <ChartCard title="Tickets no article covers" subtitle="By category">
            {gaps.length ? <BarList label="Tickets with no matching article" items={gaps} /> : <EmptyState title="Every ticket has an article" />}
          </ChartCard>
        </GridItem>
      </CardGrid>

      <CardGrid label="Customer experience">
        <GridItem span={3}>
          <MetricCard title="Customers who wrote more than once" value={`${exp.repeatCustomers.toLocaleString("en-GB")} of ${exp.customers.toLocaleString("en-GB")}`} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Tickets reopened by a reply" value={exp.reopened.toLocaleString("en-GB")} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Open for over a week (now)" value={exp.openOverWeek.toLocaleString("en-GB")} href="/admin/tickets" renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Waiting over a day for a first reply (now)" value={exp.unansweredOverDay.toLocaleString("en-GB")} href="/admin/tickets" renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>} />
        </GridItem>
      </CardGrid>
    </Stack>
  );
}

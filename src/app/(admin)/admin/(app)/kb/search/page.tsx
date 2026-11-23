import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Button, EmptyState, PageHeader, Panel, Select, Stack, TextField } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { AUDIENCE_LABELS } from "@/lib/kb/access";
import { embeddingsConfigured } from "@/lib/kb/embeddings";
import { searchKb } from "@/lib/kb/queries";

export const metadata: Metadata = { title: "Test search" };
export const dynamic = "force-dynamic";

/** Shows which passages the chatbot would be given for a question. */
export default async function SearchTestPage({ searchParams }: { searchParams: Promise<{ q?: string; segment?: string }> }) {
  const staff = await requireStaff("kb.view");
  const { q = "", segment: seg } = await searchParams;
  const segments = staff.segmentsFor("kb.view");
  const segment = seg === "b2b" && segments.includes("b2b") ? "b2b" : segments.includes("b2c") ? "b2c" : "b2b";
  const [hits, semantic] = await Promise.all([q.trim() ? searchKb(q, segment) : Promise.resolve([]), embeddingsConfigured()]);
  return (
    <Stack>
      <PageHeader title="Test search" description="Ask a question the way a customer would, and see which published passages the chatbot would answer from." />
      {!semantic && <Alert tone="info">Matching on words only. Add a Voyage AI key in Integrations to match on meaning too.</Alert>}
      <form action="/admin/kb/search" className="ds-stack ds-stack-small ds-width-8" role="search">
        <TextField label="Question" name="q" defaultValue={q} placeholder="My frame has cracked near the rear axle, is that covered?" />
        {segments.length > 1 && (
          <Select label="Asked by" name="segment" defaultValue={segment}>
            <option value="b2c">A rider (B2C)</option>
            <option value="b2b">A dealer (B2B)</option>
          </Select>
        )}
        <div className="ds-inline">
          <Button type="submit">Search</Button>
        </div>
      </form>
      {q.trim() &&
        (hits.length === 0 ? (
          <EmptyState title="Nothing found">The chatbot would say it can&apos;t answer and offer a ticket. This question may be worth an article.</EmptyState>
        ) : (
          hits.map((h, i) => (
            <Panel
              key={h.chunkId}
              headingLevel={3}
              title={`${i + 1}. ${h.heading}`}
              description={`Matched on ${h.matchedBy.join(" and ")} · score ${h.score.toFixed(4)}`}
              actions={<Link href={`/admin/kb/articles/${h.articleId}`} className="btn-s sz-s">Open article</Link>}
            >
              <Stack gap="small">
                <span>
                  <Badge>{AUDIENCE_LABELS[h.audience]}</Badge>
                </span>
                <p className="ds-body">{h.content}</p>
              </Stack>
            </Panel>
          ))
        ))}
    </Stack>
  );
}

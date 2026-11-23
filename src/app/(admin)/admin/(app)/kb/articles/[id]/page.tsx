import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Breadcrumb, Button, CardGrid, DescriptionList, GridItem, PageHeader, Panel, Stack, Status, TextArea } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { Markdown } from "@/components/Markdown";
import { requireStaff } from "@/lib/auth/session";
import type { KbAudience } from "@/lib/db/schema";
import { AUDIENCE_LABELS, canChange, canSee } from "@/lib/kb/access";
import { articleState, getArticle } from "@/lib/kb/service";
import { formatDateTime } from "@/lib/tickets/format";
import { ArticleFields } from "../../ArticleFields";
import { articleStateAction, saveArticleAction } from "../../actions";
import { STATE_LABELS } from "@/lib/kb/labels";

export const metadata: Metadata = { title: "Article" };
export const dynamic = "force-dynamic";

const VERSION_STATUS = { draft: "Draft", in_review: "In review", published: "Published", superseded: "Replaced", rejected: "Discarded" } as const;
const SOURCE_KIND = { ticket: "Ticket", email: "Email", zoho_case: "Zoho case", web: "Web page" } as const;

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const staff = await requireStaff("kb.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getArticle(id);
  if (!data || !canSee(staff, data.article.audience)) notFound();
  const { article, working, published, versions, sources } = data;
  const { saved } = await searchParams;
  const state = articleState({ ...article, workingStatus: working?.status ?? null });
  const s = STATE_LABELS[state];
  const may = { edit: canChange(staff, "kb.edit", article.audience), approve: canChange(staff, "kb.approve", article.audience) };
  const segs = staff.segmentsFor("kb.edit");
  const audiences: KbAudience[] = segs.length === 2 ? ["b2c", "b2b", "both"] : segs;
  const current = working ?? published;
  const title = current?.title ?? "Untitled";
  const retired = Boolean(article.retiredAt);

  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Knowledge base", href: "/admin/kb" }, { label: title }]} />}
        title={title}
        description={
          <span className="ds-inline ds-inline-small">
            <Status tone={s.tone}>{s.label}</Status>
            <Badge>{AUDIENCE_LABELS[article.audience]}</Badge>
            {working?.audience && working.audience !== article.audience && <span>Changes to {AUDIENCE_LABELS[working.audience]} when this draft is published</span>}
            {article.category && <span>{article.category}</span>}
          </span>
        }
      />
      {saved && <Alert tone="success">Draft saved.</Alert>}
      {working?.reviewNote && working.status === "draft" && (
        <Alert tone="warning" title="Changes requested">
          {working.reviewNote}
        </Alert>
      )}
      <CardGrid>
        <GridItem span={8}>
          <Stack>
            {may.edit && !retired ? (
              <Panel title={working ? `Version ${working.number} (${VERSION_STATUS[working.status].toLowerCase()})` : `Edit (starts version ${(published?.number ?? 0) + 1})`} description={published ? "Changes stay out of the chatbot until they're published." : undefined}>
                <ActionForm action={saveArticleAction} label="Edit article">
                  <input type="hidden" name="id" value={article.id} />
                  <ArticleFields title={current?.title} body={current?.body} audience={current?.audience ?? article.audience} category={article.category} audiences={audiences.includes(article.audience) ? audiences : [article.audience, ...audiences]} />
                  <div className="ds-inline">
                    {may.approve ? (
                      <>
                        <Button type="submit" name="intent" value="publish">Save and publish</Button>
                        <Button type="submit" name="intent" value="save" variant="secondary">Save draft</Button>
                      </>
                    ) : (
                      <>
                        <Button type="submit" name="intent" value="submit">Save and send for review</Button>
                        <Button type="submit" name="intent" value="save" variant="secondary">Save draft</Button>
                      </>
                    )}
                  </div>
                </ActionForm>
              </Panel>
            ) : current ? (
              <Panel title={working ? `Version ${working.number}` : "Published version"}>
                <Markdown>{current.body}</Markdown>
              </Panel>
            ) : null}
            {published && working && (
              <Panel title={`Live now: version ${published.number}`} description="What the chatbot reads until the new version is published.">
                <Markdown>{published.body}</Markdown>
              </Panel>
            )}
          </Stack>
        </GridItem>
        <GridItem span={4}>
          <Stack>
            {working?.status === "in_review" && may.approve && !retired && (
              <Panel title="Review" description={`Sent by ${working.authorLabel}${working.submittedAt ? `, ${formatDateTime(working.submittedAt)}` : ""}.`}>
                <ActionForm action={articleStateAction} label="Review">
                  <input type="hidden" name="id" value={article.id} />
                  <div className="ds-inline">
                    <Button type="submit" name="intent" value="publish">Approve and publish</Button>
                  </div>
                  <TextArea label="Or send back with a note" name="note" rows={3} />
                  <div className="ds-inline">
                    <Button type="submit" name="intent" value="changes" variant="secondary">Request changes</Button>
                  </div>
                </ActionForm>
              </Panel>
            )}
            <Panel title="Versions">
              <DescriptionList
                items={versions.map((v) => ({
                  term: `Version ${v.number}: ${VERSION_STATUS[v.status]}`,
                  detail: `${v.authorLabel}, ${formatDateTime(v.updatedAt)}${v.reviewedAt && v.status === "published" ? ` · approved ${formatDateTime(v.reviewedAt)}` : ""}`,
                }))}
              />
            </Panel>
            {sources.length > 0 && (
              <Panel title="Sources" description="What it was written from.">
                <DescriptionList
                  items={sources.map((src) => ({
                    term: SOURCE_KIND[src.kind],
                    detail:
                      src.kind === "ticket" ? (
                        <Link href={`/admin/tickets/${src.reference.replace(/^WS-/, "")}`}>{src.reference}{src.title ? `: ${src.title}` : ""}</Link>
                      ) : src.kind === "web" ? (
                        <a href={src.reference} target="_blank" rel="noreferrer noopener">{src.title ?? src.reference}</a>
                      ) : (
                        src.title ?? src.reference
                      ),
                  }))}
                />
              </Panel>
            )}
            {(may.edit || may.approve) && (
              <Panel title="Manage">
                <ActionForm action={articleStateAction} label="Manage article">
                  <input type="hidden" name="id" value={article.id} />
                  <div className="ds-inline">
                    {working?.status === "draft" && may.edit && !may.approve && <Button type="submit" name="intent" value="submit" size="small" variant="secondary">Send for review</Button>}
                    {working && may.edit && <Button type="submit" name="intent" value="discard" size="small" variant="secondary">{published ? "Discard changes" : "Delete draft"}</Button>}
                    {published && may.approve && (retired ? <Button type="submit" name="intent" value="restore" size="small" variant="secondary">Restore</Button> : <Button type="submit" name="intent" value="retire" size="small" variant="secondary">Retire</Button>)}
                  </div>
                </ActionForm>
              </Panel>
            )}
          </Stack>
        </GridItem>
      </CardGrid>
    </Stack>
  );
}

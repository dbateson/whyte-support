import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Button, PageHeader, Stack, TopBar } from "@whyte/design-system";
import logo from "@whyte/design-system/logos/whyte-lockup-horizontal.svg";
import { eq } from "drizzle-orm";
import { ChatApp } from "@/components/chat/ChatApp";
import { Markdown } from "@/components/Markdown";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

/** A published rider-facing article. Dealer-only articles, drafts and retired articles aren't public. */
const publicArticle = cache(async (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [row] = await db()
    .select({ audience: schema.kbArticles.audience, title: schema.kbArticleVersions.title, body: schema.kbArticleVersions.body, publishedAt: schema.kbArticleVersions.createdAt })
    .from(schema.kbArticles)
    .innerJoin(schema.kbArticleVersions, eq(schema.kbArticleVersions.id, schema.kbArticles.publishedVersionId))
    .where(eq(schema.kbArticles.id, id));
  return row && row.audience !== "b2b" ? row : null;
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const a = await publicArticle((await params).id);
  return a ? { title: a.title, description: a.body.replace(/[#*_>`\[\]]/g, "").slice(0, 160) } : { title: "Article not found" };
}

export default async function HelpArticle({ params }: { params: Promise<{ id: string }> }) {
  const a = await publicArticle((await params).id);
  if (!a) notFound();
  return (
    <Stack gap="large">
      <TopBar brand={<Image src={logo} alt="Whyte" width={140} height={32} priority />} product="Support" />
      <main className="ds-container">
        <div className="ds-width-8">
          <Stack gap="large">
            <PageHeader title={a.title} />
            <Markdown>{a.body}</Markdown>
            <Stack gap="small">
              <p>Still need help?</p>
              <div>
                <Button href="/" variant="secondary">
                  Contact support
                </Button>
              </div>
            </Stack>
          </Stack>
        </div>
      </main>
      <ChatApp contactUrl="/" />
    </Stack>
  );
}

import type { Metadata } from "next";
import { Breadcrumb, Button, PageHeader, Stack } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import type { KbAudience } from "@/lib/db/schema";
import { ArticleFields } from "../../ArticleFields";
import { createArticleAction } from "../../actions";

export const metadata: Metadata = { title: "New article" };

export default async function NewArticlePage() {
  const staff = await requireStaff("kb.edit");
  const segs = staff.segmentsFor("kb.edit");
  const audiences: KbAudience[] = segs.length === 2 ? ["b2c", "b2b", "both"] : segs;
  return (
    <Stack>
      <PageHeader breadcrumb={<Breadcrumb items={[{ label: "Knowledge base", href: "/admin/kb" }, { label: "New article" }]} />} title="New article" />
      <div className="ds-width-8">
        <ActionForm action={createArticleAction} label="New article">
          <ArticleFields audiences={audiences} />
          <div className="ds-inline">
            <Button type="submit">Save draft</Button>
          </div>
        </ActionForm>
      </div>
    </Stack>
  );
}

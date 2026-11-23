import type { Metadata } from "next";
import Link from "next/link";
import { Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { forgotPassword } from "../actions";

export const metadata: Metadata = { title: "Forgotten password" };

export default function ForgotPage() {
  return (
    <Stack>
      <PageHeader title="Reset your password" description="We'll email you a link to choose a new one." />
      <ActionForm action={forgotPassword} label="Reset password">
        <TextField label="Email" name="email" type="email" autoComplete="username" required autoFocus />
        <div className="ds-inline">
          <Button type="submit">Send link</Button>
          <Link href="/admin/login" className="btn-t">
            Back to sign in
          </Link>
        </div>
      </ActionForm>
    </Stack>
  );
}

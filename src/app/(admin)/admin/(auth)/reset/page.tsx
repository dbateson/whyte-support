import type { Metadata } from "next";
import { Alert, Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { peekToken } from "@/lib/auth/users";
import { resetPassword } from "../actions";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const user = token ? await peekToken(token, "reset") : null;
  if (!user) {
    return (
      <Alert tone="error" title="This link has expired">
        Reset links work for an hour and only once. Ask for a new one from the sign-in page.
      </Alert>
    );
  }
  return (
    <Stack>
      <PageHeader title="Choose a new password" description={user.email} />
      <ActionForm action={resetPassword} label="New password">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="email" value={user.email} />
        <TextField label="New password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} help={`At least ${PASSWORD_MIN_LENGTH} characters.`} required />
        <TextField label="New password again" name="confirm" type="password" autoComplete="new-password" required />
        <div className="ds-inline">
          <Button type="submit">Save password</Button>
        </div>
      </ActionForm>
    </Stack>
  );
}

import type { Metadata } from "next";
import { Alert, Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { peekToken } from "@/lib/auth/users";
import { acceptInvite } from "../actions";

export const metadata: Metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

export default async function AcceptPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const user = token ? await peekToken(token, "invite") : null;
  if (!user) {
    return (
      <Alert tone="error" title="This invitation has expired">
        Invitations work for 7 days and only once. Ask an admin to send you a new one.
      </Alert>
    );
  }
  return (
    <Stack>
      <PageHeader title="Welcome to Whyte Support" description={`Set up your account for ${user.email}.`} />
      <ActionForm action={acceptInvite} label="Set up your account">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="email" value={user.email} />
        <TextField label="Your name" name="name" defaultValue={user.name} autoComplete="name" required />
        <TextField label="Password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} help={`At least ${PASSWORD_MIN_LENGTH} characters. A few words together works well.`} required />
        <TextField label="Password again" name="confirm" type="password" autoComplete="new-password" required />
        <div className="ds-inline">
          <Button type="submit">Save and continue</Button>
        </div>
      </ActionForm>
    </Stack>
  );
}

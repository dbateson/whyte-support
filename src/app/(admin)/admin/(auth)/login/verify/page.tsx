import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { readSession } from "@/lib/auth/session";
import { signOut, verifyCode } from "../../actions";

export const metadata: Metadata = { title: "Enter your code" };

export default async function VerifyPage() {
  const s = await readSession();
  if (!s) redirect("/admin/login");
  if (s.mfaVerified) redirect("/admin");
  if (!s.totpEnabled) redirect("/admin/login/setup");
  return (
    <Stack>
      <PageHeader title="Enter your code" description="Open your authenticator app and enter the 6-digit code for Whyte Support." />
      <ActionForm action={verifyCode} label="Verification code">
        <TextField label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
        <div className="ds-inline">
          <Button type="submit">Continue</Button>
        </div>
      </ActionForm>
      <form action={signOut}>
        <Button variant="tertiary" type="submit">Cancel and sign out</Button>
      </form>
    </Stack>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { readSession } from "@/lib/auth/session";
import { signIn } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ set?: string }> }) {
  const s = await readSession();
  if (s?.mfaVerified) redirect("/admin");
  const { set } = await searchParams;
  return (
    <Stack>
      <PageHeader title="Sign in to Whyte Support" />
      <ActionForm action={signIn} label="Sign in">
        {set && <Alert tone="success">Password saved. Sign in to continue.</Alert>}
        <TextField label="Email" name="email" type="email" autoComplete="username" required autoFocus />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
        <div className="ds-inline">
          <Button type="submit">Sign in</Button>
          <Link href="/admin/forgot" className="btn-t">
            Forgotten your password?
          </Link>
        </div>
      </ActionForm>
    </Stack>
  );
}

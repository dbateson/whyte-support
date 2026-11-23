import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { Button, PageHeader, Stack, TextField } from "@whyte/design-system";
import { CodeBlock } from "@whyte/design-system/client";
import { ActionForm } from "@/components/ActionForm";
import { readSession } from "@/lib/auth/session";
import { otpauthUri } from "@/lib/auth/totp";
import { confirmTotpSetup, pendingTotpSecret } from "../../actions";

export const metadata: Metadata = { title: "Set up two-step sign-in" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const s = await readSession();
  if (!s) redirect("/admin/login");
  if (s.mfaVerified) redirect("/admin");
  if (s.totpEnabled) redirect("/admin/login/verify");
  const pending = await pendingTotpSecret();
  if (!pending) redirect("/admin/login");
  const uri = otpauthUri(pending.secret, pending.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 200, errorCorrectionLevel: "M" });
  const grouped = pending.secret.match(/.{1,4}/g)!.join(" ");
  return (
    <Stack>
      <PageHeader title="Set up two-step sign-in" description="Every staff account uses an authenticator app (such as Google Authenticator, Microsoft Authenticator or 1Password) as well as a password." />
      <Stack>
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
        <img src={qr} width={200} height={200} alt="QR code for your authenticator app" />
        <CodeBlock label="Or enter this key in the app" code={grouped} />
        <ActionForm action={confirmTotpSetup} label="Confirm authenticator">
          <TextField label="Code from the app" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
          <div className="ds-inline">
            <Button type="submit">Turn on and continue</Button>
          </div>
        </ActionForm>
      </Stack>
    </Stack>
  );
}

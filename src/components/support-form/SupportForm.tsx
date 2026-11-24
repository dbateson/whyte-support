"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Fieldset, Radio, Select, Spinner, Stack, TextArea, TextField } from "@whyte/design-system";
import { FileField, formatBytes, type FileFieldItem } from "@whyte/design-system/client";
import { Turnstile } from "./Turnstile";

/** What /api/public/config returns. */
interface FormConfig {
  categories: string[];
  turnstileSiteKey: string | null;
  phone: { b2c: string | null; b2b: string | null };
  privacyUrl: string | null;
  attachments: { accept: string; maxFiles: number; maxBytes: number };
}

type Segment = "b2c" | "b2b";
type Item = FileFieldItem & { attachmentId?: string };

export interface SupportFormProps {
  /** Where the API lives. "" on the support site; the support site's origin when embedded elsewhere. */
  apiBase?: string;
  /** From the Shopify App Proxy page: a signed token naming the signed-in customer. */
  shopifyToken?: string;
  prefill?: { name?: string; email?: string; segment?: Segment };
  /** For the embed: a light-DOM element for the Turnstile check (see Turnstile). */
  turnstileContainer?: HTMLElement;
}

const BIKE_CATEGORIES = new Set(["Warranty", "Technical", "Parts and spares", "Returns"]);
const ORDER_CATEGORIES = new Set(["Order or delivery", "Returns", "Parts and spares"]);

function newClaimKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The public support form. Riders and dealers each get the fields that
 * matter to them; warranty claims ask for the bike's details. Files upload
 * straight to storage while the person fills in the rest.
 */
export function SupportForm({ apiBase = "", shopifyToken, prefill, turnstileContainer }: SupportFormProps) {
  const [config, setConfig] = useState<FormConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [segment, setSegment] = useState<Segment>(prefill?.segment ?? "b2c");
  const [category, setCategory] = useState("Warranty");
  const [files, setFiles] = useState<Item[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ reference: string; email: string } | null>(null);
  const claimKey = useRef<string>("");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    claimKey.current = newClaimKey();
    fetch(`${apiBase}/api/public/config`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setConfig)
      .catch(() => setLoadError(true));
  }, [apiBase]);

  const update = (id: string, patch: Partial<Item>) => setFiles((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const addFiles = useCallback(
    async (chosen: File[]) => {
      if (!config) return;
      setFileError(null);
      const room = config.attachments.maxFiles - files.length;
      if (room <= 0) {
        setFileError(`You can attach up to ${config.attachments.maxFiles} files.`);
        return;
      }
      const accept = new Set(config.attachments.accept.split(","));
      const batch = chosen.slice(0, room).map((file) => ({ file, item: { id: crypto.randomUUID(), name: file.name, size: file.size, status: "uploading" } as Item }));
      if (chosen.length > room) setFileError(`Only the first ${room} were added: the limit is ${config.attachments.maxFiles} files.`);
      for (const b of batch) {
        if (!accept.has(b.file.type)) Object.assign(b.item, { status: "error", error: "Use a photo, a PDF or a short video" });
        else if (b.file.size > config.attachments.maxBytes) Object.assign(b.item, { status: "error", error: `Over ${formatBytes(config.attachments.maxBytes)}` });
      }
      setFiles((list) => [...list, ...batch.map((b) => b.item)]);
      const toSend = batch.filter((b) => b.item.status === "uploading");
      if (toSend.length === 0) return;
      try {
        const res = await fetch(`${apiBase}/api/public/uploads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimKey: claimKey.current, files: toSend.map((b) => ({ name: b.file.name, size: b.file.size, type: b.file.type })) }),
        });
        const body = (await res.json().catch(() => ({}))) as { slots?: ({ id: string; upload: { url: string; headers: Record<string, string> } } | { error: string })[]; error?: string };
        if (!res.ok || !body.slots) throw new Error(body.error ?? "Couldn't upload");
        await Promise.all(
          toSend.map(async (b, i) => {
            const slot = body.slots![i];
            if (!slot || "error" in slot) return update(b.item.id, { status: "error", error: slot && "error" in slot ? slot.error : "Couldn't upload" });
            const put = await fetch(slot.upload.url, { method: "PUT", headers: slot.upload.headers, body: b.file });
            update(b.item.id, put.ok ? { status: "done", attachmentId: slot.id } : { status: "error", error: "Couldn't upload. Try again" });
          }),
        );
      } catch (err) {
        toSend.forEach((b) => update(b.item.id, { status: "error", error: err instanceof Error ? err.message : "Couldn't upload" }));
      }
    },
    [apiBase, config, files.length],
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (files.some((f) => f.status === "uploading")) {
      setError("Wait for your files to finish uploading.");
      return;
    }
    if (config?.turnstileSiteKey && !turnstileToken) {
      setError("Please complete the check above the Send button.");
      return;
    }
    const data = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    setSubmitting(true);
    setError(null);
    setFields({});
    try {
      const res = await fetch(`${apiBase}/api/public/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...data,
          segment,
          category,
          attachments: files.filter((f) => f.status === "done" && f.attachmentId).map((f) => f.attachmentId),
          claimKey: claimKey.current,
          turnstileToken,
          shopifyToken,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { reference?: string; error?: string; fields?: Record<string, string> };
      if (!res.ok || !body.reference) {
        setError(body.error ?? "Something went wrong. Please try again.");
        setFields(body.fields ?? {});
        formRef.current?.scrollIntoView({ block: "start" });
        return;
      }
      setDone({ reference: body.reference, email: data.email ?? "" });
    } catch {
      setError("We couldn't reach our server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const phone = config?.phone[segment];

  if (done) {
    return (
      <Alert tone="success" title={`Thanks: your reference is ${done.reference}`}>
        We&apos;ve emailed a copy to {done.email}. One of the team will reply, usually within two working days. To add anything, just reply to that email.
      </Alert>
    );
  }
  if (loadError) {
    return (
      <Alert tone="error" title="The form didn't load">
        Please refresh the page{phone ? `, or call us on ${phone}` : ""}.
      </Alert>
    );
  }
  if (!config) return <Spinner label="Loading the form" />;

  const showBike = BIKE_CATEGORIES.has(category);
  const showOrder = ORDER_CATEGORIES.has(category);
  const uploading = files.some((f) => f.status === "uploading");

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate={false} aria-label="Contact Whyte support">
      <Stack gap="large">
        {error && <Alert tone="error">{error}</Alert>}

        <Fieldset legend="Are you a rider or a dealer?" columns={2}>
          <Radio name="segmentChoice" value="b2c" label="I ride a Whyte" description="Your own bike, parts or an order" checked={segment === "b2c"} onChange={() => setSegment("b2c")} />
          <Radio name="segmentChoice" value="b2b" label="I'm a dealer or trade customer" description="A shop, fleet or trade account" checked={segment === "b2b"} onChange={() => setSegment("b2b")} />
        </Fieldset>

        <Select label="What's it about?" name="categoryChoice" value={category} onChange={(e) => setCategory(e.target.value)}>
          {config.categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>

        <Stack gap="small">
          <h2 className="ds-heading-small">Your details</h2>
          <TextField label="Name" name="name" autoComplete="name" required defaultValue={prefill?.name} error={fields.name} />
          <TextField label="Email" name="email" type="email" autoComplete="email" required defaultValue={prefill?.email} error={fields.email} help="We'll reply here." />
          <TextField label="Phone (optional)" name="phone" type="tel" autoComplete="tel" error={fields.phone} />
          {segment === "b2b" && (
            <>
              <TextField label="Business name" name="company" autoComplete="organization" required error={fields.company} />
              <TextField label="Whyte account number (if you know it)" name="accountCode" error={fields.accountCode} />
            </>
          )}
        </Stack>

        {(showBike || showOrder) && (
          <Stack gap="small">
            <h2 className="ds-heading-small">{showBike ? "Your bike" : "Your order"}</h2>
            {showBike && (
              <>
                <TextField label="Model and year" name="productModel" placeholder="e.g. 905, 2024" error={fields.productModel} />
                <TextField label="Frame number" name="frameNumber" help="Stamped under the bottom bracket, where the cranks meet the frame." error={fields.frameNumber} />
                <TextField label="Date bought" name="purchaseDate" type="date" max={new Date().toISOString().slice(0, 10)} error={fields.purchaseDate} />
                <TextField label="Where you bought it" name="purchasedFrom" placeholder="Shop name, or whytebikes.com" error={fields.purchasedFrom} />
              </>
            )}
            {showOrder && <TextField label="Order number (if you have one)" name="orderNumber" error={fields.orderNumber} />}
          </Stack>
        )}

        <Stack gap="small">
          <h2 className="ds-heading-small">How can we help?</h2>
          <TextField label="Summary" name="summary" required maxLength={200} placeholder="I'm looking for new bearings" error={fields.summary} />
          <TextArea label="Details" name="details" rows={7} required minLength={10} help="What happened, when, and anything you've tried." error={fields.details} />
          <FileField
            label="Photos or documents (optional)"
            help={
              category === "Warranty"
                ? "For warranty, photos of the problem, the frame number and your receipt help us decide quickly."
                : `Up to ${config.attachments.maxFiles} files, ${formatBytes(config.attachments.maxBytes)} each.`
            }
            accept={config.attachments.accept}
            files={files}
            error={fileError ?? undefined}
            onAdd={addFiles}
            onRemove={(id) => setFiles((list) => list.filter((f) => f.id !== id))}
          />
        </Stack>

        {/* Hidden from people; bots fill it in. */}
        <div className="vh" aria-hidden="true">
          <label>
            Leave this empty <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        {config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} container={turnstileContainer} />}

        <Stack gap="small">
          <p className="ds-body-small">
            We use what you send to answer your request and keep a record of it.
            {config.privacyUrl && (
              <>
                {" "}
                See our <a href={config.privacyUrl} target="_blank" rel="noreferrer">privacy policy</a>.
              </>
            )}
          </p>
          <div className="ds-inline">
            <Button type="submit" disabled={submitting || uploading}>
              {submitting ? "Sending…" : "Send"}
            </Button>
            {phone && <span className="ds-body-small">Or call us on {phone}</span>}
          </div>
        </Stack>
      </Stack>
    </form>
  );
}

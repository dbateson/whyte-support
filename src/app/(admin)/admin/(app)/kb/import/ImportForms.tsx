"use client";

import { useState } from "react";
import { Alert, Button, Checkbox, Fieldset, Panel, Select, Stack, TextField } from "@whyte/design-system";
import { FileField, type FileFieldItem } from "@whyte/design-system/client";
import { requestImportUploads, startImport } from "./actions";

function AudienceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select label="When it isn't clear, assume they're for" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="b2c">Riders (B2C)</option>
      <option value="b2b">Dealers (B2B)</option>
      <option value="both">Both</option>
    </Select>
  );
}

/** Uploads files straight to storage, then starts the import. */
function FileImport({ kind, title, description, accept, multiple, defaultDomains }: { kind: "mbox" | "zoho_csv"; title: string; description: string; accept: string; multiple: boolean; defaultDomains: string }) {
  const [files, setFiles] = useState<(FileFieldItem & { file: File })[]>([]);
  const [audience, setAudience] = useState(kind === "zoho_csv" ? "b2c" : "b2c");
  const [domains, setDomains] = useState(defaultDomains);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    if (files.length === 0) return setError("Choose a file first.");
    setBusy(true);
    try {
      const res = await requestImportUploads(files.map((f) => ({ name: f.name, size: f.size })));
      if (!res.slots) throw new Error(res.error ?? "Couldn't prepare the upload.");
      setFiles((l) => l.map((f) => ({ ...f, status: "uploading" })));
      await Promise.all(
        files.map(async (f, i) => {
          const slot = res.slots![i]!;
          const put = await fetch(slot.upload.url, { method: "PUT", headers: { ...slot.upload.headers, "content-type": "application/octet-stream" }, body: f.file });
          if (!put.ok) throw new Error(`${f.name} didn't upload (${put.status}).`);
          setFiles((l) => l.map((x) => (x.id === f.id ? { ...x, status: "done" } : x)));
        }),
      );
      const eml = files.every((f) => f.name.toLowerCase().endsWith(".eml"));
      const r = await startImport({
        kind: kind === "mbox" && eml ? "eml" : kind,
        label: label || files.map((f) => f.name).join(", ").slice(0, 200),
        audience,
        staffDomains: domains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
        files: files.map((f, i) => ({ key: res.slots![i]!.key, size: f.size })),
      });
      if (r?.error) throw new Error(r.error);
    } catch (err) {
      if (err && typeof err === "object" && "digest" in err) throw err; // the redirect to the job page
      setError(err instanceof Error ? err.message : "The import didn't start.");
      setBusy(false);
    }
  }

  return (
    <Panel title={title} description={description}>
      <Stack gap="small">
        {error && <Alert tone="error">{error}</Alert>}
        <FileField
          label="Files"
          accept={accept}
          multiple={multiple}
          disabled={busy}
          files={files}
          onAdd={(chosen) => setFiles((l) => [...(multiple ? l : []), ...chosen.map((file) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, file }))])}
          onRemove={(id) => setFiles((l) => l.filter((f) => f.id !== id))}
        />
        <TextField label="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Support inbox 2023–2025" />
        {kind === "mbox" && (
          <TextField label="Whyte's email domains" value={domains} onChange={(e) => setDomains(e.target.value)} help="Messages from these domains are Whyte's replies; the rest are customers. Comma-separated." />
        )}
        <AudienceSelect value={audience} onChange={setAudience} />
        <div className="ds-inline">
          <Button onClick={go} disabled={busy}>{busy ? "Uploading…" : "Upload and import"}</Button>
        </div>
      </Stack>
    </Panel>
  );
}

function WebImport() {
  const [url, setUrl] = useState("https://www.whytebikes.com/sitemap.xml");
  const [include, setInclude] = useState<Set<string>>(new Set(["pages"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (k: string) => setInclude((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await startImport({ kind: "web", label: `whytebikes.com (${[...include].join(", ")})`, audience: "both", sitemapUrl: url, include: [...include] });
      if (r?.error) throw new Error(r.error);
    } catch (err) {
      if (err && typeof err === "object" && "digest" in err) throw err;
      setError(err instanceof Error ? err.message : "The import didn't start.");
      setBusy(false);
    }
  }
  return (
    <Panel title="whytebikes.com" description="Reads the site's pages and drafts an article from each one with support information (warranty, sizing, servicing, specs). Up to 300 pages.">
      <Stack gap="small">
        {error && <Alert tone="error">{error}</Alert>}
        <TextField label="Sitemap" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Fieldset legend="Include" columns={3}>
          <Checkbox label="Pages" description="Warranty, delivery, sizing" checked={include.has("pages")} onChange={() => toggle("pages")} />
          <Checkbox label="Products" description="Bikes and parts" checked={include.has("products")} onChange={() => toggle("products")} />
          <Checkbox label="Blog posts" description="Guides and news" checked={include.has("blogs")} onChange={() => toggle("blogs")} />
        </Fieldset>
        <div className="ds-inline">
          <Button onClick={go} disabled={busy || include.size === 0}>{busy ? "Starting…" : "Read the site"}</Button>
        </div>
      </Stack>
    </Panel>
  );
}

export function ImportForms({ defaultDomains }: { defaultDomains: string }) {
  return (
    <Stack>
      <FileImport
        kind="mbox"
        title="Past support emails"
        description="An .mbox export of the support inbox (Gmail: Google Takeout; Outlook: export, then convert), or individual .eml files. Conversations are grouped into threads, personal details are removed, and topics answered more than once become draft articles."
        accept=".mbox,.eml,application/mbox,message/rfc822"
        multiple
        defaultDomains={defaultDomains}
      />
      <FileImport
        kind="zoho_csv"
        title="Zoho CRM cases"
        description="A CSV export of the Cases module (Zoho CRM: Cases → Export). Subject, Description and Solution are read; cases with an account are treated as dealer cases."
        accept=".csv,text/csv"
        multiple={false}
        defaultDomains={defaultDomains}
      />
      <WebImport />
    </Stack>
  );
}

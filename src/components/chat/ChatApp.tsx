"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, ChatMessage, ChatThread, Fieldset, Inline, Radio, Stack, TextArea, TextField } from "@whyte/design-system";
import { ChatComposer, ChatWidget } from "@whyte/design-system/client";
import { Markdown } from "@/components/Markdown";
import { Turnstile } from "@/components/support-form/Turnstile";

type Segment = "b2c" | "b2b";

interface Source {
  title: string;
  articleId: string;
  url: string | null;
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  offerTicket?: boolean;
  /** Only real answers ask for feedback; fallbacks ("I can't find that") don't. */
  answered?: boolean;
  feedback?: 1 | -1;
  failed?: boolean;
}

interface Saved {
  sessionId: string;
  token: string;
  segment: Segment;
  phone: string | null;
  turns: Turn[];
  reference?: string;
}

export interface ChatAppProps {
  /** Where the API lives. "" on the support site; the support site's origin when embedded. */
  apiBase?: string;
  /** Skip the rider/dealer question. */
  segment?: Segment;
  /** From the Shopify App Proxy: a signed token naming the signed-in customer. */
  shopifyToken?: string;
  /**
   * On a Shopify store: the App Proxy path that says who is signed in
   * ("/apps/support/identity"). Fetched (same origin) when a chat starts.
   */
  identityUrl?: string;
  prefill?: { name?: string; email?: string };
  /** For the embed: a light-DOM element for the Turnstile check. */
  turnstileContainer?: HTMLElement;
  /** Where the contact form is, for when the assistant isn't available. */
  contactUrl?: string;
}

const STORE = "whyte-support-chat";

/** sessionStorage can be missing or throw (private windows, blocked storage); the chat works without it. */
function load(): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(s: Saved | null) {
  try {
    if (s) window.sessionStorage.setItem(STORE, JSON.stringify(s));
    else window.sessionStorage.removeItem(STORE);
  } catch {
    /* not kept: fine */
  }
}

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; fields?: Record<string, string> }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, status: res.status, error: data.error ?? "Something went wrong. Please try again.", fields: data.fields };
  } catch {
    return { ok: false, status: 0, error: "We couldn't reach the server. Check your connection and try again." };
  }
}

/**
 * The support assistant: a corner chat that answers from the knowledge base,
 * shows which articles each answer came from, and hands the conversation to
 * the team as a ticket (or gives the phone number) when it can't help.
 */
export function ChatApp({ apiBase = "", segment: fixedSegment, shopifyToken, identityUrl, prefill, turnstileContainer, contactUrl }: ChatAppProps) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<{ enabled: boolean; turnstileSiteKey: string | null } | null>(null);
  const [state, setState] = useState<Saved | null>(null);
  const [segment, setSegment] = useState<Segment>(fixedSegment ?? "b2c");
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [escalating, setEscalating] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // A chat carries on across pages: it's kept for the tab and picked up when the panel opens.
  const restored = useRef(false);
  const openChange = (next: boolean) => {
    if (next && !restored.current) {
      restored.current = true;
      if (!state) setState(load());
    }
    setOpen(next);
  };
  useEffect(() => {
    if (restored.current) save(state);
  }, [state]);

  // The config is fetched on first open, so a page with the launcher costs nothing until it's used.
  useEffect(() => {
    if (!open || config) return;
    fetch(`${apiBase}/api/public/config`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((c) => setConfig({ enabled: Boolean(c.chat?.enabled), turnstileSiteKey: c.turnstileSiteKey ?? null }))
      .catch(() => setConfig({ enabled: false, turnstileSiteKey: null }));
  }, [open, config, apiBase]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [state?.turns.length, busy, escalating]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    setBusy(true);
    let current = state;
    if (!current) {
      let customerToken = shopifyToken;
      if (!customerToken && identityUrl) {
        customerToken = await fetch(identityUrl, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { token?: string } | null) => d?.token || undefined)
          .catch(() => undefined);
      }
      const r = await post<{ sessionId: string; token: string; segment: Segment; phone: string | null }>(`${apiBase}/api/public/chat/sessions`, { segment, turnstileToken, shopifyToken: customerToken });
      if (!r.ok) {
        setBusy(false);
        setError(r.error);
        return;
      }
      current = { ...r.data, turns: [] };
    }
    const userTurn: Turn = { id: `u-${Date.now()}`, role: "user", text };
    current = { ...current, turns: [...current.turns, userTurn] };
    setState(current);
    setDraft("");
    const r = await post<{ messageId: string; reply: string; outcome: string; sources: Source[]; offerTicket: boolean; phone: string | null }>(`${apiBase}/api/public/chat/messages`, {
      sessionId: current.sessionId,
      token: current.token,
      message: text,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) {
        // The session is gone (expired or cleared): start again on the next message.
        setState(null);
        setDraft(text);
      } else {
        setState((s) => s && { ...s, turns: s.turns.map((t) => (t.id === userTurn.id ? { ...t, failed: true } : t)) });
      }
      setError(r.error);
      return;
    }
    setState((s) => s && { ...s, phone: r.data.phone, turns: [...s.turns, { id: r.data.messageId, role: "assistant", text: r.data.reply, sources: r.data.sources, offerTicket: r.data.offerTicket, answered: r.data.outcome === "answered" || r.data.outcome === "partial" }] });
  }, [draft, busy, state, apiBase, segment, turnstileToken, shopifyToken, identityUrl]);

  const feedback = async (turn: Turn, value: 1 | -1) => {
    if (!state) return;
    setState((s) => s && { ...s, turns: s.turns.map((t) => (t.id === turn.id ? { ...t, feedback: value } : t)) });
    await post(`${apiBase}/api/public/chat/feedback`, { sessionId: state.sessionId, token: state.token, messageId: turn.id, value });
  };

  const restart = () => {
    setState(null);
    setEscalating(false);
    setError(null);
  };

  const needsHuman = state?.turns.some((t) => t.offerTicket);
  const phone = state?.phone;

  return (
    <ChatWidget
      open={open}
      onOpenChange={openChange}
      title="Whyte support"
      subtitle="Answers from our help articles"
      headerActions={
        state ? (
          <Button variant="tertiary" onClick={restart}>
            New chat
          </Button>
        ) : undefined
      }
    >
      {!config ? null : !config.enabled ? (
        <div>
          <Alert tone="info" title="The assistant isn't available right now">
            {contactUrl ? (
              <>
                Please <a href={contactUrl}>send us a message</a> and the team will reply by email.
              </>
            ) : (
              "Please use the contact form and the team will reply by email."
            )}
          </Alert>
        </div>
      ) : state?.reference ? (
        <div>
          <Alert tone="success" title={`Sent to the team: ${state.reference}`}>
            The team will reply by email. Quote this reference if you contact us about it.
          </Alert>
        </div>
      ) : escalating && state ? (
        <EscalateForm
          apiBase={apiBase}
          state={state}
          prefill={prefill}
          onCancel={() => setEscalating(false)}
          onDone={(reference) => {
            setEscalating(false);
            setState((s) => s && { ...s, reference });
          }}
        />
      ) : (
        <>
          <ChatThread label="Conversation with the assistant">
            <ChatMessage role="assistant" author="Assistant">
              <p>Hi! Ask me about warranty, setting up or looking after your bike, or orders. I answer from our help articles, and I can pass you to the team if they don&apos;t cover it.</p>
            </ChatMessage>
            {state?.turns.map((t) =>
              t.role === "user" ? (
                <ChatMessage key={t.id} role="user" author="You" status={t.failed ? "error" : undefined} meta={t.failed ? "Not sent" : undefined}>
                  {t.text}
                </ChatMessage>
              ) : (
                <ChatMessage
                  key={t.id}
                  role="assistant"
                  author="Assistant"
                  meta={
                    // Meta is a paragraph: inline content only.
                    <>
                      {t.sources && t.sources.length > 0 && (
                        <>
                          From:{" "}
                          {t.sources.map((s, i) => (
                            <span key={s.articleId}>
                              {i > 0 && ", "}
                              {s.url ? (
                                <a href={`${apiBase}${s.url}`} target="_blank" rel="noreferrer noopener">
                                  {s.title}
                                </a>
                              ) : (
                                s.title
                              )}
                            </span>
                          ))}
                          <br />
                        </>
                      )}
                      {!t.answered ? null : t.feedback ? (
                        "Thanks for the feedback."
                      ) : (
                        <>
                          Did this help?{" "}
                          <Button variant="tertiary" onClick={() => feedback(t, 1)}>
                            Yes
                          </Button>{" "}
                          <Button variant="tertiary" onClick={() => feedback(t, -1)}>
                            No
                          </Button>
                        </>
                      )}
                    </>
                  }
                >
                  <Markdown>{t.text}</Markdown>
                </ChatMessage>
              ),
            )}
            {busy && <ChatMessage role="assistant" author="Assistant" status="streaming" streamingLabel="Looking that up" />}
            <div ref={endRef} />
          </ChatThread>
          <Stack gap="small">
              {error && <Alert tone="error">{error}</Alert>}
              {!state && !fixedSegment && (
                <Fieldset legend="Are you a rider or a dealer?" columns={2}>
                  <Radio name="chatSegment" value="b2c" label="I ride a Whyte" checked={segment === "b2c"} onChange={() => setSegment("b2c")} />
                  <Radio name="chatSegment" value="b2b" label="Dealer or trade" checked={segment === "b2b"} onChange={() => setSegment("b2b")} />
                </Fieldset>
              )}
              {!state && config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} container={turnstileContainer} />}
              {(needsHuman || (state && state.turns.length >= 2)) && (
                <Inline gap="small">
                  <Button variant={needsHuman ? "primary" : "secondary"} size="small" onClick={() => setEscalating(true)}>
                    Send this to the team
                  </Button>
                  {phone && needsHuman && (
                    <Button variant="tertiary" href={`tel:${phone.replace(/\s/g, "")}`}>
                      {`Or call ${phone}`}
                    </Button>
                  )}
                </Inline>
              )}
              <ChatComposer
                label="Your question"
                placeholder="Ask a question"
                value={draft}
                onChange={setDraft}
                onSubmit={send}
                busy={busy}
                disabled={!state && Boolean(config.turnstileSiteKey) && !turnstileToken}
                maxRows={5}
                hint="Please don't include card or bank details."
              />
            </Stack>
        </>
      )}
    </ChatWidget>
  );
}

function EscalateForm({
  apiBase,
  state,
  prefill,
  onCancel,
  onDone,
}: {
  apiBase: string;
  state: Saved;
  prefill?: { name?: string; email?: string };
  onCancel: () => void;
  onDone: (reference: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const value = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    setSubmitting(true);
    setError(null);
    const r = await post<{ reference: string }>(`${apiBase}/api/public/chat/escalate`, {
      sessionId: state.sessionId,
      token: state.token,
      name: value("name"),
      email: value("email"),
      phone: value("phone"),
      company: value("company"),
      note: value("note"),
    });
    setSubmitting(false);
    if (r.ok) return onDone(r.data.reference);
    setError(r.error);
    setFields(r.fields ?? {});
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="standard">
        <p>We&apos;ll send the team this conversation, so you won&apos;t need to repeat yourself. They reply by email.</p>
        {error && <Alert tone="error">{error}</Alert>}
        <TextField label="Your name" name="name" autoComplete="name" defaultValue={prefill?.name} error={fields.name} required />
        <TextField label="Email" name="email" type="email" autoComplete="email" defaultValue={prefill?.email} error={fields.email} required />
        {state.segment === "b2b" && <TextField label="Business name" name="company" autoComplete="organization" error={fields.company} />}
        <TextField label="Phone (optional)" name="phone" type="tel" autoComplete="tel" error={fields.phone} />
        <TextArea label="Anything to add? (optional)" name="note" rows={3} help="For warranty, the frame number and photos help. The team will ask for photos by email." error={fields.note} />
        <Inline gap="small">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Sending…" : "Send to the team"}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Back to chat
          </Button>
        </Inline>
      </Stack>
    </form>
  );
}

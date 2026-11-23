/**
 * An in-memory stand-in for Zoho CRM's API (the parts the sync uses), for
 * tests: install() replaces fetch for zoho.eu hosts and passes others through.
 */
type Rec = Record<string, unknown> & { id: string; Modified_Time: string; Created_Time: string };

export class FakeZoho {
  modules: Record<string, Map<string, Rec>> = { Cases: new Map(), Contacts: new Map(), Accounts: new Map() };
  notes = new Map<string, { id: string; caseId: string; Note_Title?: string; Note_Content: string; Created_Time: string; Created_By: { name: string } }>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  tokensIssued = 0;
  /** Make the next n API calls fail with this. */
  failNext: { status: number; code: string; times: number } | null = null;
  private seq = 1000;
  private clock = Date.parse("2026-11-01T10:00:00Z");

  nextId() {
    return String(++this.seq * 1000);
  }
  tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }

  add(module: string, fields: Record<string, unknown>): Rec {
    const t = this.tick();
    const rec = { id: this.nextId(), Created_Time: t, Modified_Time: t, ...fields } as Rec;
    if (module === "Cases" && !rec.Case_Number) rec.Case_Number = String(this.seq);
    this.modules[module]!.set(rec.id, rec);
    return rec;
  }
  edit(module: string, id: string, fields: Record<string, unknown>) {
    const rec = this.modules[module]!.get(id)!;
    Object.assign(rec, fields, { Modified_Time: this.tick() });
  }
  addNote(caseId: string, content: string, by = "Sam in Zoho") {
    const id = this.nextId();
    this.notes.set(id, { id, caseId, Note_Content: content, Created_Time: this.tick(), Created_By: { name: by } });
    return id;
  }
  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }

  install(): () => void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!/(^|\.)(zoho|zohoapis)\.eu$/.test(url.hostname)) return real(input, init);
      return this.handle(url, init ?? {});
    }) as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  }

  private json(body: unknown, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname === "/oauth/v2/token") {
      this.tokensIssued++;
      const p = new URLSearchParams(String(init.body));
      if (p.get("grant_type") === "authorization_code") return this.json({ access_token: `at-${this.tokensIssued}`, refresh_token: "rt-from-code", expires_in: 3600, api_domain: "https://www.zohoapis.eu" });
      return this.json({ access_token: `at-${this.tokensIssued}`, expires_in: 3600, api_domain: "https://www.zohoapis.eu" });
    }
    const path = url.pathname.replace(/^\/crm\/v8/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    if (this.failNext && this.failNext.times > 0) {
      this.failNext.times--;
      return this.json({ code: this.failNext.code, message: "fake failure", status: "error" }, this.failNext.status);
    }
    const headers = new Headers(init.headers);
    if (!/^Zoho-oauthtoken at-\d+$/.test(headers.get("authorization") ?? "")) return this.json({ code: "INVALID_OAUTHTOKEN", status: "error" }, 401);

    let m: RegExpExecArray | null;
    if ((m = /^\/(Cases|Contacts|Accounts)\/search$/.exec(path))) {
      const email = url.searchParams.get("email")?.toLowerCase();
      const found = [...this.modules[m[1]!]!.values()].filter((r) => String(r.Email ?? "").toLowerCase() === email);
      return found.length ? this.json({ data: found }) : this.json(null, 204);
    }
    if ((m = /^\/Cases\/(\d+)\/Notes$/.exec(path))) {
      const caseId = m[1]!;
      if (method === "POST") {
        const data = (body.data as { Note_Title?: string; Note_Content: string }[]).map((n) => {
          const id = this.nextId();
          this.notes.set(id, { id, caseId, Note_Title: n.Note_Title, Note_Content: n.Note_Content, Created_Time: this.tick(), Created_By: { name: "API" } });
          return { code: "SUCCESS", status: "success", message: "record added", details: { id } };
        });
        return this.json({ data }, 201);
      }
      const list = [...this.notes.values()].filter((n) => n.caseId === caseId);
      return list.length ? this.json({ data: list, info: { more_records: false } }) : this.json(null, 204);
    }
    if ((m = /^\/(Cases|Contacts|Accounts)\/(\d+)$/.exec(path))) {
      const rec = this.modules[m[1]!]!.get(m[2]!);
      if (method === "PUT") {
        if (!rec) return this.json({ data: [{ code: "INVALID_DATA", status: "error", message: "no record", details: {} }] }, 400);
        this.edit(m[1]!, rec.id, body.data[0]);
        return this.json({ data: [{ code: "SUCCESS", status: "success", message: "record updated", details: { id: rec.id } }] });
      }
      return rec ? this.json({ data: [rec] }) : this.json(null, 204);
    }
    if ((m = /^\/(Cases|Contacts|Accounts)$/.exec(path))) {
      const mod = m[1]!;
      if (method === "POST") {
        const rec = this.add(mod, body.data[0]);
        return this.json({ data: [{ code: "SUCCESS", status: "success", message: "record added", details: { id: rec.id } }] }, 201);
      }
      const ids = url.searchParams.get("ids");
      let list = [...this.modules[mod]!.values()];
      if (ids) list = list.filter((r) => ids.split(",").includes(r.id));
      const since = headers.get("if-modified-since");
      if (since) list = list.filter((r) => Date.parse(r.Modified_Time) >= Date.parse(since));
      list.sort((a, b) => Date.parse(a.Modified_Time) - Date.parse(b.Modified_Time));
      const per = Number(url.searchParams.get("per_page") ?? 200);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = list.slice((page - 1) * per, page * per);
      if (!slice.length) return this.json(null, 204);
      return this.json({ data: slice, info: { more_records: list.length > page * per, page, per_page: per } });
    }
    if (path === "/actions/watch") return this.json({ watch: [{ code: "SUCCESS", status: "success" }] });
    if (path === "/settings/fields") return this.json({ fields: [] });
    return this.json({ code: "NOT_FOUND", status: "error" }, 404);
  }
}

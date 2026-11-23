/** The chat itself, loaded by support-chat.js once the page is idle. */
import { createRoot, type Root } from "react-dom/client";
import { ChatApp } from "@/components/chat/ChatApp";
import { prepareShadow } from "./shared/shadow";

const loader = document.getElementById("whyte-support-chat-app") as HTMLScriptElement | null;
const defaultBase = loader?.dataset.base ?? window.location.origin;

class WhyteSupportChat extends HTMLElement {
  private root?: Root;

  connectedCallback() {
    if (this.root) return;
    const base = (this.getAttribute("api-base") ?? defaultBase).replace(/\/$/, "");
    const { mount, turnstile } = prepareShadow(this, base);
    const segment = this.getAttribute("segment");
    this.root = createRoot(mount);
    this.root.render(
      <ChatApp
        apiBase={base}
        segment={segment === "b2b" || segment === "b2c" ? segment : undefined}
        identityUrl={this.getAttribute("identity-url") ?? undefined}
        contactUrl={this.getAttribute("contact-url") ?? `${base}/`}
        prefill={{ name: this.getAttribute("name") ?? undefined, email: this.getAttribute("email") ?? undefined }}
        turnstileContainer={turnstile}
      />,
    );
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = undefined;
  }
}

if (!customElements.get("whyte-support-chat")) customElements.define("whyte-support-chat", WhyteSupportChat);

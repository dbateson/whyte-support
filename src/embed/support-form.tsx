/**
 * <whyte-support-form>: the support form for other sites (whytebikes.com).
 *
 *   <script src="https://support.whytebikes.com/embed/support-form.js" defer></script>
 *   <whyte-support-form></whyte-support-form>
 *
 * Optional attributes: segment="b2b", name, email (prefill), shopify-token
 * (set by the App Proxy page), api-base (defaults to the script's origin).
 * Renders in a shadow root so the site's CSS and ours can't collide.
 */
import { createRoot, type Root } from "react-dom/client";
import { SupportForm } from "@/components/support-form/SupportForm";
import { prepareShadow } from "./shared/shadow";

const scriptOrigin = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  try {
    return src ? new URL(src).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

class WhyteSupportForm extends HTMLElement {
  private root?: Root;

  connectedCallback() {
    if (this.root) return;
    const base = (this.getAttribute("api-base") ?? scriptOrigin).replace(/\/$/, "");
    const { mount, turnstile } = prepareShadow(this, base);
    const segment = this.getAttribute("segment");
    this.root = createRoot(mount);
    this.root.render(
      <SupportForm
        apiBase={base}
        shopifyToken={this.getAttribute("shopify-token") ?? undefined}
        prefill={{
          name: this.getAttribute("name") ?? undefined,
          email: this.getAttribute("email") ?? undefined,
          segment: segment === "b2b" || segment === "b2c" ? segment : undefined,
        }}
        turnstileContainer={turnstile}
      />,
    );
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = undefined;
  }
}

if (!customElements.get("whyte-support-form")) customElements.define("whyte-support-form", WhyteSupportForm);

/**
 * <whyte-support-chat>: the support assistant for other sites (whytebikes.com).
 *
 *   <script src="https://support.whytebikes.com/embed/support-chat.js" defer></script>
 *
 * This loader is tiny. The chat itself (React, the design system) is fetched
 * once the page is idle, so it doesn't slow the store down. With no
 * <whyte-support-chat> element on the page, one is added to <body>.
 *
 * Optional attributes on the element: segment="b2b", identity-url
 * ("/apps/support/identity" on the Shopify store, so signed-in dealers are
 * recognised), contact-url (the contact form), name, email, api-base.
 */
const script = document.currentScript as HTMLScriptElement | null;
const base = (() => {
  try {
    return script?.src ? new URL(script.src).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

function boot() {
  if (!document.querySelector("whyte-support-chat")) document.body.appendChild(document.createElement("whyte-support-chat"));
  if (document.getElementById("whyte-support-chat-app")) return;
  const s = document.createElement("script");
  s.id = "whyte-support-chat-app";
  s.src = `${base}/embed/support-chat-app.js`;
  s.async = true;
  s.dataset.base = base;
  document.head.appendChild(s);
}

const idle = (cb: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500));
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => idle(boot));
else idle(boot);

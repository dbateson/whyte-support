"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void }) => string;
      remove: (id: string) => void;
    };
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | undefined;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Turnstile didn't load"));
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Cloudflare's "are you human" check. Usually invisible; sometimes a tick box.
 * `container`: render into this element instead (the embed passes a light-DOM
 * element slotted into its shadow root, as Turnstile renders in the page).
 */
export function Turnstile({ siteKey, onToken, container }: { siteKey: string; onToken: (token: string | undefined) => void; container?: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | undefined;
    let cancelled = false;
    loadScript()
      .then(() => {
        const target = container ?? ref.current;
        if (cancelled || !target || !window.turnstile) return;
        id = window.turnstile.render(target, {
          sitekey: siteKey,
          callback: (t) => onToken(t),
          "expired-callback": () => onToken(undefined),
          "error-callback": () => onToken(undefined),
        });
      })
      .catch(() => onToken(undefined));
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, onToken, container]);
  return container ? <slot name="turnstile" /> : <div ref={ref} />;
}

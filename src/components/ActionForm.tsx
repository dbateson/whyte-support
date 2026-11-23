"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import { Alert, type StackGap } from "@whyte/design-system";
import { CodeBlock } from "@whyte/design-system/client";

/** What a form's server action returns: a message to show, or nothing (it redirected). */
export type ActionState = {
  error?: string;
  notice?: string;
  /** Something to show once and copy, such as an invitation link. Never put these in a URL. */
  reveal?: { label: string; value: string };
  done?: number;
} | null;
export type FormAction = (prev: ActionState, data: FormData) => Promise<ActionState>;

/**
 * A form posting to a server action, with its result shown above the fields.
 * Fields keep what was typed when the action fails (React resets forms after
 * an action by default); `resetOnSuccess` clears them after it succeeds.
 * Fields are disabled while it runs.
 */
export function ActionForm({
  action,
  children,
  resetOnSuccess = false,
  gap = "small",
  label,
}: {
  action: FormAction;
  children: ReactNode;
  resetOnSuccess?: boolean;
  gap?: StackGap;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.done && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      aria-label={label}
      aria-busy={pending || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        const data = new FormData(e.currentTarget, submitter);
        startTransition(() => formAction(data));
      }}
    >
      <fieldset className={gap === "standard" ? "ds-stack" : `ds-stack ds-stack-${gap}`} disabled={pending}>
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        {state?.notice && <Alert tone="success">{state.notice}</Alert>}
        {state?.reveal && <CodeBlock label={state.reveal.label} code={state.reveal.value} wrap />}
        {children}
      </fieldset>
    </form>
  );
}

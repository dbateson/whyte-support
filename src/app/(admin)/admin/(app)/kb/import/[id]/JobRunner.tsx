"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spinner } from "@whyte/design-system";
import { cancelImport, stepImport } from "../actions";

/** Keeps an import moving while its page is open: one step at a time, then refreshes the page's figures. */
export function JobRunner({ jobId, active }: { jobId: string; active: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(active);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  useEffect(() => {
    if (!running) return;
    stop.current = false;
    (async () => {
      while (!stop.current) {
        try {
          const r = await stepImport(jobId);
          router.refresh();
          if (r.status === "done" || r.status === "failed" || r.status === "cancelled") break;
        } catch {
          setError("Lost contact with the server. Processing will carry on tonight, or reload to resume.");
          break;
        }
      }
      setRunning(false);
    })();
    return () => {
      stop.current = true;
    };
  }, [running, jobId, router]);

  if (error) return <Alert tone="warning">{error}</Alert>;
  if (!running) return null;
  return (
    <div className="ds-inline">
      <Spinner label="Working" />
      <span className="ds-body-small">Working on it. You can leave this page: it carries on tonight, or when you come back.</span>
      <Button
        size="small"
        variant="secondary"
        onClick={async () => {
          stop.current = true;
          await cancelImport(jobId);
          setRunning(false);
          router.refresh();
        }}
      >
        Cancel import
      </Button>
    </div>
  );
}

import { useEffect, useState } from "react";
import { PublicStatusPageView } from "@infrawrench/ui";
import type { PublicStatusPage } from "@infrawrench/client-core";

/**
 * Public status page when the SPA shell is served on a vanity hostname by
 * status-page-edge. The Worker injects `<meta name="iw-status-host">`;
 * `__root.tsx` detects that and renders this instead of the authenticated app.
 */
export function PublicStatusPageOnCustomHost() {
  const [page, setPage] = useState<PublicStatusPage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/status", {
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
        if (cancelled) return;
        if (res.status === 404) {
          setState("missing");
          return;
        }
        if (!res.ok) {
          setState("error");
          return;
        }
        setPage((await res.json()) as PublicStatusPage);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (page) document.title = page.title;
  }, [page]);

  if (state === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface-tertiary">
        <div className="animate-pulse text-sm">Loading…</div>
      </div>
    );
  }

  if (state === "missing" || state === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface px-4 text-center">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">
            {state === "missing" ? "Status page not found" : "Status page unavailable"}
          </h1>
          <p className="mt-2 text-sm text-on-surface-secondary">
            {state === "missing"
              ? "This domain is not linked to a published status page."
              : "Something went wrong loading this page. Try again in a moment."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface">{page && <PublicStatusPageView page={page} />}</div>
  );
}

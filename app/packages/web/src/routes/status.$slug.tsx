import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { PublicStatusPageView } from "@infrawrench/ui";
import type { PublicStatusPage } from "@infrawrench/client-core";

export const Route = createFileRoute("/status/$slug")({
  component: PublicStatusPageRoute,
});

/**
 * The public status page at `/status/:slug`.
 *
 * Deliberately fetched with a bare `fetch`, not `apiGet`: the shared client
 * attaches credentials and redirects to sign-in on a 401, and both behaviours
 * are wrong here. A visitor with no account must get the page, and a visitor
 * *with* an account must not have their session identified to a page that is
 * meant to be anonymous.
 *
 * `__root.tsx` treats `/status/` as a public route, so no auth check runs
 * before this renders.
 */
function PublicStatusPageRoute() {
  const gt = useGT();
  const { slug } = Route.useParams();
  const [page, setPage] = useState<PublicStatusPage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/status/${encodeURIComponent(slug)}`, {
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
  }, [slug]);

  useEffect(() => {
    if (page) document.title = page.title;
  }, [page]);

  if (state === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface-tertiary">
        <div className="animate-pulse text-sm">{gt("Loading…")}</div>
      </div>
    );
  }

  if (state === "missing" || state === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface px-4 text-center">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">
            {state === "missing" ? gt("Status page not found") : gt("Status page unavailable")}
          </h1>
          <p className="mt-2 text-sm text-on-surface-secondary">
            {state === "missing"
              ? gt("This link is no longer valid, or the page hasn't been published.")
              : gt("Something went wrong loading this page. Try again in a moment.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface">{page && <PublicStatusPageView page={page} />}</div>
  );
}

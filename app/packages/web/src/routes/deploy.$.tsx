import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";

import { apiGet } from "@/lib/api";

/**
 * Hotlink into a deploy: `/deploy/github.com/owner/name`.
 *
 * The point is that a README badge or a chat message can drop someone straight
 * onto the deploy screen for a specific repository. The splat accepts the host
 * prefix so a URL can be pasted from the address bar, and tolerates a `.git`
 * suffix and a trailing slash for the same reason.
 *
 * With one organization it redirects immediately; with several it asks, because
 * guessing which org owns a repository would land people in the wrong place.
 * Either way the repository is carried through, so the choice is never lost.
 */
export const Route = createFileRoute("/deploy/$")({
  component: DeployHotlink,
});

/** `github.com/owner/name`, `owner/name`, `.../name.git` → `owner/name`. */
export function parseRepoPath(splat: string): string | null {
  const cleaned = splat
    .replace(/^https?:\/\//, "")
    .replace(/^(?:www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

interface OrgRow {
  id: string;
  displayName: string;
}

function DeployHotlink() {
  const navigate = useNavigate();
  const params = useParams({ from: "/deploy/$" });
  const splat = (params as { _splat?: string })._splat ?? "";
  const repo = parseRepoPath(splat);

  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;

    void (async () => {
      try {
        const rows = await apiGet<OrgRow[]>("/api/auth/orgs");
        if (cancelled) return;
        if (rows.length === 1) {
          void navigate({
            to: "/org/$orgId/deployments",
            params: { orgId: rows[0]!.id },
            search: { repo },
            replace: true,
          });
          return;
        }
        setOrgs(rows);
      } catch {
        // Not signed in (or the session lapsed). A full load lets the app's
        // normal auth flow take over, and this URL is where they come back to.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repo, navigate]);

  if (!repo) {
    return (
      <Shell title="That does not look like a repository">
        Deploy links look like{" "}
        <code className="text-on-surface">/deploy/github.com/owner/name</code>.
      </Shell>
    );
  }

  if (failed) {
    return (
      <Shell title="Sign in to deploy">
        <a href="/" className="text-info hover:underline">
          Sign in
        </a>{" "}
        and open this link again to deploy <span className="text-on-surface">{repo}</span>.
      </Shell>
    );
  }

  if (orgs && orgs.length === 0) {
    return (
      <Shell title="No organizations">
        You are not a member of an organization yet. Create one, then open this link again.
      </Shell>
    );
  }

  if (orgs) {
    return (
      <Shell title={`Deploy ${repo}`}>
        <p className="mb-3">Which organization?</p>
        <div className="flex flex-col gap-1 items-start">
          {orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() =>
                void navigate({
                  to: "/org/$orgId/deployments",
                  params: { orgId: o.id },
                  search: { repo },
                  replace: true,
                })
              }
              className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-on-surface"
            >
              {o.displayName}
            </button>
          ))}
        </div>
      </Shell>
    );
  }

  return <Shell title={`Opening deploy for ${repo}…`} />;
}

function Shell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="p-8 text-sm text-on-surface-secondary">
      <h1 className="font-semibold text-on-surface mb-2">{title}</h1>
      {children}
    </div>
  );
}

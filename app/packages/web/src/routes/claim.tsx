import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { apiPost } from "@/lib/api";

/**
 * The human half of the agent claim ceremony.
 *
 * An agent has built its user a workspace and handed them a code; this is where
 * that code turns into an organization they own. The page assumes the visitor
 * has no idea what any of this is — they were sent here by a chat message — so
 * it leads with what the workspace *is* and what happens if they walk away,
 * rather than with a form.
 */
export const Route = createFileRoute("/claim")({
  component: ClaimPage,
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search["code"] === "string" ? { code: search["code"] } : {},
});

interface MergeTarget {
  id: string;
  displayName: string;
}

interface LookupResult {
  registrationId: string;
  workspaceName: string;
  trialExpiresInMs: number | null;
  mergeTargets: MergeTarget[];
}

function formatRemaining(gt: ReturnType<typeof useGT>, ms: number | null): string {
  if (ms === null) return gt("already claimed");
  if (ms <= 0) return gt("expiring now");
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return gt("{n} minutes", { n: minutes });
}

function ClaimPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const gt = useGT();

  const [code, setCode] = useState(search.code ?? "");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [mode, setMode] = useState<"adopt" | "merge">("adopt");
  const [targetOrganizationId, setTargetOrganizationId] = useState("");
  const [moveHistory, setMoveHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLookup(value: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<LookupResult>("/api/agent/claim/lookup", { code: value });
      setLookup(result);
      const first = result.mergeTargets[0];
      if (first) setTargetOrganizationId(first.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("That code is not valid."));
    } finally {
      setBusy(false);
    }
  }

  // A code arriving in the query string comes from `verification_uri_complete`.
  // Looked up automatically, but never *claimed* automatically: binding cloud
  // credentials to an account is not something a link should be able to do on
  // its own.
  useEffect(() => {
    if (search.code && !lookup) void handleLookup(search.code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.code]);

  async function handleClaim() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ organizationId: string }>("/api/agent/claim", {
        code,
        mode,
        ...(mode === "merge" ? { targetOrganizationId, moveHistory } : {}),
      });
      void navigate({ to: "/org/$orgId", params: { orgId: result.organizationId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not claim this workspace."));
      setBusy(false);
    }
  }

  if (!lookup) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="w-full max-w-md px-6">
          <h1 className="text-2xl font-bold mb-2">{gt("Claim a workspace")}</h1>
          <p className="text-sm text-on-surface-tertiary mb-8">
            {gt(
              "An agent set up an Infrawrench workspace for you. Enter the code it gave you to " +
                "keep it — unclaimed workspaces are deleted 24 hours after they're created.",
            )}
          </p>

          <label htmlFor="claim-code" className="block text-xs text-on-surface-secondary mb-2">
            {gt("Code")}
          </label>
          <input
            id="claim-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code) void handleLookup(code);
            }}
            // i18n-ignore: claim code format hint
            placeholder="XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 mb-4 font-mono tracking-widest uppercase bg-surface-raised border border-outline rounded-lg text-on-surface"
          />

          {error && <p className="text-xs text-danger mb-4">{error}</p>}

          <button
            type="button"
            disabled={busy || !code}
            onClick={() => void handleLookup(code)}
            className="w-full px-4 py-3 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {busy ? gt("Checking…") : gt("Continue")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
      <div className="w-full max-w-md px-6">
        <h1 className="text-2xl font-bold mb-2">{lookup.workspaceName}</h1>
        <T>
          <p className="text-sm text-on-surface-tertiary mb-8">
            Deleted in{" "}
            <span className="text-warning font-medium">
              <Var>{formatRemaining(gt, lookup.trialExpiresInMs)}</Var>
            </span>{" "}
            unless you claim it now.
          </p>
        </T>

        <fieldset className="mb-6">
          <legend className="text-xs text-on-surface-secondary mb-3">
            {gt("What should happen to it?")}
          </legend>

          <label className="flex gap-3 p-3 mb-2 border border-outline rounded-lg cursor-pointer hover:bg-surface-raised">
            <input
              type="radio"
              name="mode"
              checked={mode === "adopt"}
              onChange={() => setMode("adopt")}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">
                {gt("Keep it as its own organization")}
              </span>
              <span className="block text-xs text-on-surface-tertiary">
                {gt("Everything stays exactly where it is and you become the owner.")}
              </span>
            </span>
          </label>

          {lookup.mergeTargets.length > 0 && (
            <label className="flex gap-3 p-3 border border-outline rounded-lg cursor-pointer hover:bg-surface-raised">
              <input
                type="radio"
                name="mode"
                checked={mode === "merge"}
                onChange={() => setMode("merge")}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">
                  {gt("Move it into an organization I already have")}
                </span>
                <span className="block text-xs text-on-surface-tertiary">
                  {gt(
                    "The cloud accounts move across and re-sync. Dashboards and other things " +
                      "created in this workspace are not carried over.",
                  )}
                </span>
              </span>
            </label>
          )}
        </fieldset>

        {mode === "merge" && (
          <div className="mb-6 pl-3 border-l-2 border-outline">
            <label
              htmlFor="merge-target"
              className="block text-xs text-on-surface-secondary mb-2 mt-3"
            >
              {gt("Move into")}
            </label>
            <select
              id="merge-target"
              value={targetOrganizationId}
              onChange={(e) => setTargetOrganizationId(e.target.value)}
              className="w-full px-3 py-2 mb-3 bg-surface-raised border border-outline rounded-lg text-on-surface text-sm"
            >
              {lookup.mergeTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </select>

            <label className="flex gap-2 items-start text-xs text-on-surface-tertiary">
              <input
                type="checkbox"
                checked={moveHistory}
                onChange={(e) => setMoveHistory(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                {gt(
                  "Also bring this workspace's metrics and cost history across. It can take a " +
                    "few minutes to appear, and it will change the figures on existing cost charts.",
                )}
              </span>
            </label>
          </div>
        )}

        {error && <p className="text-xs text-danger mb-4">{error}</p>}

        <button
          type="button"
          disabled={busy || (mode === "merge" && !targetOrganizationId)}
          onClick={() => void handleClaim()}
          className="w-full px-4 py-3 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {busy ? gt("Claiming…") : gt("Claim workspace")}
        </button>
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { AgentScopePicker, agentScopeGroups } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";

/**
 * Approving an agent link: a platform (Nibblets, ...) showed its user a code
 * and sent them here. Approving lets that platform create agents in one of the
 * visitor's organizations, each with its own credential and permissions, up to
 * the ceiling chosen here.
 *
 * In `skipsOrgRedirect` (`__root.tsx`) so the `?code=` survives the sign-in
 * bounce and a visitor is never funnelled into their first org first. The code
 * is looked up automatically, never approved automatically.
 */
export const Route = createFileRoute("/link-agents")({
  component: LinkAgentsPage,
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search["code"] === "string" ? { code: search["code"] } : {},
});

interface LookupOrganization {
  id: string;
  name: string;
  canApprove: boolean;
  grantableScopes: string[];
}

interface LookupResult {
  platform: string;
  label: string;
  requestedScopes: string[];
  expiresAt: string;
  organizations: LookupOrganization[];
}

function LinkAgentsPage() {
  const search = Route.useSearch();
  const gt = useGT();

  const [code, setCode] = useState(search.code ?? "");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);

  const org = lookup?.organizations.find((o) => o.id === organizationId) ?? null;
  const groups = useMemo(() => agentScopeGroups(org?.grantableScopes ?? []), [org]);

  function pickOrg(result: LookupResult, id: string) {
    setOrganizationId(id);
    const grantable = result.organizations.find((o) => o.id === id)?.grantableScopes ?? [];
    setScopes(new Set(result.requestedScopes.filter((s) => grantable.includes(s))));
  }

  async function handleLookup(value: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<LookupResult>("/api/agent-links/requests/lookup", {
        code: value,
      });
      setLookup(result);
      const first = result.organizations.find((o) => o.canApprove);
      if (first) pickOrg(result, first.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("That code is not valid."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (search.code && !lookup) void handleLookup(search.code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.code]);

  async function decide(kind: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "approve") {
        await apiPost("/api/agent-links/requests/approve", {
          code,
          organizationId,
          scopes: [...scopes],
        });
        setDone("approved");
      } else {
        await apiPost("/api/agent-links/requests/deny", { code });
        setDone("denied");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not record your decision."));
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-surface text-on-surface py-10">
      <div className="w-full max-w-lg px-6">{children}</div>
    </div>
  );

  if (done) {
    return shell(
      <>
        <h1 className="text-2xl font-bold mb-2">
          {done === "approved" ? gt("Platform connected") : gt("Request denied")}
        </h1>
        <p className="text-sm text-on-surface-tertiary">
          {done === "approved"
            ? gt(
                "You can close this tab. Agents it creates appear in Settings → Agent Credentials, where you " +
                  "can edit or revoke them.",
              )
            : gt("Nothing was connected. You can close this tab.")}
        </p>
      </>,
    );
  }

  if (!lookup) {
    return shell(
      <>
        <h1 className="text-2xl font-bold mb-2">{gt("Connect a platform")}</h1>
        <p className="text-sm text-on-surface-tertiary mb-8">
          {gt(
            "A platform such as Nibblets wants to create agents in your organization. Enter the " +
              "code it showed you.",
          )}
        </p>
        <label htmlFor="link-code" className="block text-xs text-on-surface-secondary mb-2">
          {gt("Code")}
        </label>
        <input
          id="link-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code) void handleLookup(code);
          }}
          // i18n-ignore: link code format hint
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
      </>,
    );
  }

  const approvable = lookup.organizations.filter((o) => o.canApprove);

  return shell(
    <>
      <h1 className="text-2xl font-bold mb-2">{lookup.label}</h1>
      <T>
        <p className="text-sm text-on-surface-tertiary mb-4">
          <span className="font-mono">
            <Var>{lookup.platform}</Var>
          </span>{" "}
          wants to create agents in an organization of yours. Each agent gets its own credential and
          can never do more than what you allow here, or more than you can do yourself.
        </p>
      </T>
      <p className="text-sm text-warning mb-6">
        {gt(
          "Only approve a code you started yourself, just now. If someone sent you this link, deny it.",
        )}
      </p>

      {approvable.length === 0 ? (
        <p className="text-sm text-on-surface-tertiary mb-6">
          {gt(
            "You need permission to invite people in an organization to connect a platform to it. " +
              "Ask an administrator.",
          )}
        </p>
      ) : (
        <>
          <label htmlFor="link-org" className="block text-xs text-on-surface-secondary mb-2">
            {gt("Organization")}
          </label>
          <select
            id="link-org"
            value={organizationId}
            onChange={(e) => pickOrg(lookup, e.target.value)}
            className="w-full px-3 py-2 mb-6 bg-surface-raised border border-outline rounded-lg text-on-surface text-sm"
          >
            {approvable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>

          <p className="text-xs text-on-surface-secondary mb-2">
            {gt("The most this platform may ever grant its agents")}
          </p>
          <div className="mb-6 max-h-80 overflow-y-auto pr-2">
            <AgentScopePicker
              groups={groups}
              selected={scopes}
              onChange={setScopes}
              disabled={busy}
            />
          </div>
        </>
      )}

      {error && <p className="text-xs text-danger mb-4">{error}</p>}

      <div className="flex gap-3">
        {approvable.length > 0 && (
          <button
            type="button"
            disabled={busy || !organizationId || scopes.size === 0}
            onClick={() => void decide("approve")}
            className="flex-1 px-4 py-3 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {gt("Approve")}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("deny")}
          className="flex-1 px-4 py-3 text-sm font-medium border border-outline hover:bg-surface-raised disabled:opacity-50 rounded-lg transition-colors"
        >
          {gt("Deny")}
        </button>
      </div>
    </>,
  );
}

import { useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { AgentLinkSummary, AgentRegistration } from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { useSettingsHost } from "./host.js";
import { agentScopeGroups } from "./api-key-scopes.js";
import { AgentScopePicker } from "./AgentScopePicker.js";
import { CARD, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/**
 * Settings → Agents, "Connected platforms": the agent links approved into this
 * organization (Nibblets, ...), each with its ceiling and the agents it made,
 * nested. Revoking a link revokes its agents; an agent's scopes can be edited
 * here within the link's ceiling. Kept out of `AgentsSection` so that file stays
 * about the agent list as a whole.
 */
export function relative(gt: ReturnType<typeof useGT>, iso: string | null): string {
  if (!iso) return gt("never");
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return gt("just now");
  if (minutes < 60) return gt("{n}m ago", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return gt("{n}h ago", { n: hours });
  return gt("{n}d ago", { n: Math.floor(hours / 24) });
}

/** Scope strings as their picker labels, for the read-only summaries. */
function useScopeLabels() {
  const gtData = useDataString();
  return (values: readonly string[]): string => {
    const labels = new Map(
      agentScopeGroups().flatMap((g) => g.scopes.map((s) => [s.value, s.label] as const)),
    );
    return values.map((v) => gtData(labels.get(v) ?? v)).join(", ");
  };
}

export function ConnectedPlatforms({
  links,
  agents,
  canManage,
  onChanged,
  onError,
}: {
  links: AgentLinkSummary[];
  agents: AgentRegistration[];
  canManage: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { orgId, api } = useSettingsHost();
  const gt = useGT();
  const [editing, setEditing] = useState<string | null>(null);
  const liveLinks = links.filter((l) => !l.revokedAt);

  async function revoke(path: string, failure: string) {
    try {
      await api.delete(path);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : failure);
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{gt("Connected platforms")}</h3>
      {liveLinks.length === 0 ? (
        <div className={CARD}>
          <p className="text-sm text-on-surface-tertiary">
            {gt(
              "No platforms are connected. A platform such as Nibblets asks to connect by " +
                "showing you a code to approve.",
            )}
          </p>
        </div>
      ) : (
        liveLinks.map((link) => (
          <LinkCard
            key={link.id}
            link={link}
            agents={agents.filter((r) => r.linkId === link.id)}
            canManage={canManage}
            editing={editing}
            onEdit={setEditing}
            onSaved={async () => {
              setEditing(null);
              await onChanged();
            }}
            onRevokeLink={() =>
              void revoke(
                `/api/org/${orgId}/agent-links/${link.id}`,
                gt("Could not revoke that platform"),
              )
            }
            onRevokeAgent={(id) =>
              void revoke(
                `/api/org/${orgId}/agent-registrations/${id}`,
                gt("Could not revoke that agent"),
              )
            }
          />
        ))
      )}
    </section>
  );
}

function LinkCard({
  link,
  agents,
  canManage,
  editing,
  onEdit,
  onSaved,
  onRevokeLink,
  onRevokeAgent,
}: {
  link: AgentLinkSummary;
  agents: AgentRegistration[];
  canManage: boolean;
  editing: string | null;
  onEdit: (id: string | null) => void;
  onSaved: () => Promise<void>;
  onRevokeLink: () => void;
  onRevokeAgent: (id: string) => void;
}) {
  const gt = useGT();
  const labels = useScopeLabels();
  const live = agents.filter((a) => !a.revokedAt);

  return (
    <div className={`${CARD} space-y-3`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {link.label}
            <span className="ml-2 text-xs text-on-surface-tertiary font-mono">{link.platform}</span>
          </p>
          <p className="text-xs text-on-surface-tertiary mt-1">
            {link.approvedBy
              ? gt("Approved by {email}", { email: link.approvedBy.email })
              : gt("The person who approved this no longer exists")}{" "}
            · {gt("connected {when}", { when: relative(gt, link.createdAt) })} ·{" "}
            {gt("last used {when}", { when: relative(gt, link.lastSeenAt) })}
          </p>
          <p className="text-xs text-on-surface-tertiary mt-1">
            {gt("May grant: {scopes}", {
              scopes:
                link.effectiveScopes.length > 0 ? labels(link.effectiveScopes) : gt("nothing"),
            })}
          </p>
        </div>
        {canManage && (
          <button type="button" className={SECONDARY_BUTTON} onClick={onRevokeLink}>
            {gt("Revoke")}
          </button>
        )}
      </div>

      {live.length === 0 ? (
        <p className="text-xs text-on-surface-tertiary pl-3 border-l-2 border-border">
          {gt("This platform has not made any agents yet.")}
        </p>
      ) : (
        <div className="space-y-2 pl-3 border-l-2 border-border">
          {live.map((agent) =>
            editing === agent.id ? (
              <EditAgentScopes
                key={agent.id}
                link={link}
                agent={agent}
                onCancel={() => onEdit(null)}
                onSaved={onSaved}
              />
            ) : (
              <div key={agent.id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm truncate">{agent.label ?? gt("Unnamed agent")}</p>
                  <p className="text-xs text-on-surface-tertiary">
                    {(agent.scopes ?? []).length > 0 ? labels(agent.scopes ?? []) : gt("No scopes")}
                  </p>
                  <p className="text-xs text-on-surface-tertiary">
                    {(agent.providers ?? []).length > 0
                      ? gt("Only: {providers}", {
                          providers: providerNames(link, agent.providers ?? []),
                        })
                      : gt("All providers")}{" "}
                    · {gt("last used {when}", { when: relative(gt, agent.lastSeenAt) })}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => onEdit(agent.id)}
                    >
                      {gt("Edit scopes")}
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => onRevokeAgent(agent.id)}
                    >
                      {gt("Revoke")}
                    </button>
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function providerNames(link: AgentLinkSummary, ids: readonly string[]): string {
  return ids.map((id) => link.providers.find((p) => p.id === id)?.displayName ?? id).join(", ");
}

function EditAgentScopes({
  link,
  agent,
  onCancel,
  onSaved,
}: {
  link: AgentLinkSummary;
  agent: AgentRegistration;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { orgId, api } = useSettingsHost();
  const gt = useGT();
  const [scopes, setScopes] = useState<Set<string>>(new Set(agent.scopes ?? []));
  const [providers, setProviders] = useState<Set<string>>(new Set(agent.providers ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => agentScopeGroups(link.effectiveScopes), [link.effectiveScopes]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/org/${orgId}/agent-registrations/${agent.id}`, {
        scopes: [...scopes],
        providers: [...providers],
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not save these scopes"));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 py-2">
      <p className="text-sm font-medium">
        {gt("Scopes for {name}", { name: agent.label ?? gt("Unnamed agent") })}
      </p>
      <AgentScopePicker groups={groups} selected={scopes} onChange={setScopes} disabled={saving} />
      {link.providers.length > 0 && (
        <fieldset>
          <legend className="text-xs font-medium text-on-surface-secondary mb-1">
            {gt("Only these providers (leave all unticked for every provider)")}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {link.providers.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={providers.has(p.id)}
                  disabled={saving}
                  onChange={(e) => {
                    const next = new Set(providers);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    setProviders(next);
                  }}
                />
                <span>{p.displayName}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? gt("Saving…") : gt("Save")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </div>
  );
}

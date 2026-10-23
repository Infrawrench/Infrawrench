import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { AgentLinkSummary, AgentRegistration } from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";
import { ConnectedPlatforms, relative } from "./ConnectedPlatforms.js";
import { CARD, SECONDARY_BUTTON } from "./styles.js";

/**
 * The agent registrations acting in this organization, and the platforms
 * (agent links) allowed to make them.
 *
 * Distinct from the **Agents** workspace tab, which is coding-agent VM
 * sessions and has nothing to do with authentication. This page answers "what
 * non-human things can reach our cloud accounts, who vouched for them, and how
 * do I stop one" — the same question the API Keys page answers for tokens a
 * person minted, which is why it sits directly beside it.
 */
export function AgentsSection() {
  const { orgId, api, has } = useSettingsHost();
  const gt = useGT();
  const [rows, setRows] = useState<AgentRegistration[]>([]);
  const [links, setLinks] = useState<AgentLinkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canRevoke = has("team:invite");

  async function load() {
    setLoading(true);
    try {
      const [agents, linkRows] = await Promise.all([
        api.get<AgentRegistration[]>(`/api/org/${orgId}/agent-registrations`),
        api.get<AgentLinkSummary[]>(`/api/org/${orgId}/agent-links`),
      ]);
      setRows(agents);
      setLinks(linkRows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not load agents"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function handleRevoke(id: string) {
    try {
      await api.delete(`/api/org/${orgId}/agent-registrations/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not revoke that agent"));
    }
  }

  const standalone = rows.filter((row) => !row.linkId);

  if (loading) return <p className="text-sm text-on-surface-tertiary">{gt("Loading…")}</p>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-on-surface-tertiary">
        {gt(
          "Agents that registered themselves and were claimed into this organization, and agents " +
            "made by platforms you connected. An agent can never manage billing, mint API keys, " +
            "invite people, or revoke another agent.",
        )}
      </p>

      {error && <p className="text-xs text-danger">{error}</p>}

      <ConnectedPlatforms
        links={links}
        agents={rows}
        canManage={canRevoke}
        onChanged={load}
        onError={setError}
      />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{gt("Claimed agents")}</h3>
        {standalone.length === 0 ? (
          <div className={CARD}>
            <p className="text-sm text-on-surface-tertiary">
              {gt("No agents have been claimed into this organization.")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {standalone.map((row) => (
              <div key={row.id} className={`${CARD} flex items-start justify-between gap-4`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {row.label ?? gt("Unnamed agent")}
                    {row.revokedAt && (
                      <span className="ml-2 text-xs text-danger">{gt("revoked")}</span>
                    )}
                    {!row.revokedAt && !row.claimedAt && (
                      <span className="ml-2 text-xs text-warning">{gt("unclaimed")}</span>
                    )}
                  </p>
                  <p className="text-xs text-on-surface-tertiary mt-1">
                    {row.prefix ? `${row.prefix}…` : gt("external credential")} ·{" "}
                    {gt("last used {when}", { when: relative(gt, row.lastSeenAt) })}
                  </p>
                  <p className="text-xs text-on-surface-tertiary">
                    {row.claimedByEmail
                      ? gt("Claimed by {email}", { email: row.claimedByEmail })
                      : gt("Never claimed by a person")}
                  </p>
                </div>
                {!row.revokedAt && canRevoke && (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => void handleRevoke(row.id)}
                  >
                    {gt("Revoke")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

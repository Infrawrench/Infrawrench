import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { useSettingsHost } from "./host.js";
import { CARD, SECONDARY_BUTTON } from "./styles.js";

/**
 * The agent registrations acting in this organization.
 *
 * Distinct from the **Agents** workspace tab, which is coding-agent VM
 * sessions and has nothing to do with authentication. This page answers "what
 * non-human things can reach our cloud accounts, who vouched for them, and how
 * do I stop one" — the same question the API Keys page answers for tokens a
 * person minted, which is why it sits directly beside it.
 */
interface AgentRegistration {
  id: string;
  label: string | null;
  kind: string;
  prefix: string | null;
  claimedAt: string | null;
  claimedByUserId: string | null;
  claimedByEmail: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function relative(gt: ReturnType<typeof useGT>, iso: string | null): string {
  if (!iso) return gt("never");
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return gt("just now");
  if (minutes < 60) return gt("{n}m ago", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return gt("{n}h ago", { n: hours });
  return gt("{n}d ago", { n: Math.floor(hours / 24) });
}

export function AgentsSection() {
  const { orgId, api, has } = useSettingsHost();
  const gt = useGT();
  const [rows, setRows] = useState<AgentRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canRevoke = has("team:invite");

  async function load() {
    setLoading(true);
    try {
      setRows(await api.get<AgentRegistration[]>(`/api/org/${orgId}/agent-registrations`));
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

  if (loading) return <p className="text-sm text-on-surface-tertiary">{gt("Loading…")}</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-on-surface-tertiary">
        {gt(
          "Agents that registered themselves and were claimed into this organization. An agent " +
            "acts with the permissions of whoever claimed it, and can never manage billing, mint " +
            "API keys, invite people, or revoke another agent.",
        )}
      </p>

      {error && <p className="text-xs text-danger">{error}</p>}

      {rows.length === 0 ? (
        <div className={CARD}>
          <p className="text-sm text-on-surface-tertiary">
            {gt("No agents have been claimed into this organization.")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
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
    </div>
  );
}

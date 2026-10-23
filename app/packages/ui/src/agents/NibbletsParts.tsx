import { useMemo } from "react";
import { useGT } from "gt-react";
import { AgentScopePicker } from "../settings/AgentScopePicker.js";
import { agentScopeGroups } from "../settings/api-key-scopes.js";
import { NIBBLETS_CONNECT_URL } from "./nibblets.js";
import type { AgentSession } from "./types.js";

/**
 * The Nibblets pieces of the Agents panel, kept out of `AgentsPanel.tsx` so
 * that file stays about the session list as a whole. See `nibblets.ts` for
 * what a Nibblets session is.
 */

/**
 * "Link to this organization" on the create form: when ticked, the server
 * starts linked through an agent link the creator approves, up to the scopes
 * ticked here. `linkableScopes` is what the creator could grant; `null` means
 * they cannot approve links in this organization (no `team:invite`), and
 * `undefined` that the host has no agent links at all (desktop local agents).
 */
export function NibbletsLinkOption({
  linkableScopes,
  enabled,
  onEnabledChange,
  scopes,
  onScopesChange,
  disabled,
}: {
  linkableScopes: string[] | null | undefined;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  scopes: ReadonlySet<string>;
  onScopesChange: (next: Set<string>) => void;
  disabled: boolean;
}) {
  const gt = useGT();
  const groups = useMemo(() => agentScopeGroups(linkableScopes ?? []), [linkableScopes]);

  if (linkableScopes === undefined) {
    return (
      <p className="text-xs text-on-surface-muted">
        {gt(
          "Local agents belong to no organization, so this server starts unlinked. Link apps from Nibblets' Settings.",
        )}
      </p>
    );
  }
  if (linkableScopes === null) {
    return (
      <p className="text-xs text-on-surface-muted">
        {gt(
          "You need permission to invite people to link this server to the organization, so it starts unlinked.",
        )}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        <span>{gt("Link to this organization")}</span>
      </label>
      {enabled && (
        <>
          <p className="text-xs text-on-surface-muted">
            {gt(
              "The most this server may ever give its nibblets. You choose each nibblet's own permissions in Nibblets.",
            )}
          </p>
          <div className="max-h-64 overflow-y-auto rounded border border-border bg-surface p-2">
            <AgentScopePicker
              groups={groups}
              selected={scopes}
              onChange={onScopesChange}
              disabled={disabled}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** What a Nibblets session row says about itself, and where it is used. */
export function NibbletsSessionDetails({
  session,
  onOpenLink,
}: {
  session: AgentSession;
  onOpenLink?: () => void;
}) {
  const gt = useGT();
  return (
    <>
      <div className="mt-1 text-xs text-on-surface-muted">
        {gt("Nibblets server · agents and their apps managed in Nibblets")}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
        {session.agentLinkId ? (
          onOpenLink ? (
            <button
              type="button"
              onClick={onOpenLink}
              className="text-accent hover:underline"
              title={gt("See this link and its agents in Settings → Agent Credentials")}
            >
              {gt("Linked to this organization")}
            </button>
          ) : (
            <span className="text-on-surface-muted">{gt("Linked to this organization")}</span>
          )
        ) : (
          <span className="text-on-surface-muted">{gt("Not linked to this organization")}</span>
        )}
        {session.status === "up" && (
          <a
            href={NIBBLETS_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
            title={gt("Works once Authorize server has linked it to Nibblets Connect")}
          >
            {gt("Open Nibblets")}
          </a>
        )}
      </div>
    </>
  );
}

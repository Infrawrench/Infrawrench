import { useCallback, useEffect, useRef, useState } from "react";
import {
  OWNERSHIP_LIMITS,
  formatTicketRef,
  validateOwnershipPatch,
  type ResourceOwnershipPatch,
} from "@infrawrench/client-core";
import type { OwnershipCandidate, OwnershipClient, ResourceOwnership } from "./types.js";

export interface ResourceOwnershipPanelProps {
  client: OwnershipClient;
  resourceId: string;
  resourceName: string;
}

/** The form's working copy — all four fields as strings the inputs can bind to. */
interface Draft {
  ownerUserId: string;
  ownerLabel: string;
  purpose: string;
  ticketUrl: string;
}

function draftFrom(record: ResourceOwnership | null): Draft {
  return {
    ownerUserId: record?.ownerUserId ?? "",
    ownerLabel: record?.ownerLabel ?? "",
    purpose: record?.purpose ?? "",
    ticketUrl: record?.ticketUrl ?? "",
  };
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return (
    a.ownerUserId === b.ownerUserId &&
    a.ownerLabel === b.ownerLabel &&
    a.purpose === b.purpose &&
    a.ticketUrl === b.ticketUrl
  );
}

/**
 * The resource detail page's Ownership tab: who owns this resource, what it is
 * for, and the ticket that authorized it.
 *
 * Editing is a plain form rather than a modal, because unlike a lease or a
 * schedule this is reference data people come to *read* at least as often as
 * they come to change it — and reading it behind a button is the reason
 * ownership metadata goes stale everywhere else.
 *
 * The owner field is two controls on purpose. The picker sets a routable
 * member; the text box takes a team name for cases a member can't express. The
 * copy under them says plainly which one gets alerted, because a user who
 * types "Platform team" and expects a page is the failure this feature must
 * not have.
 */
export function ResourceOwnershipPanel({
  client,
  resourceId,
  resourceName,
}: ResourceOwnershipPanelProps) {
  const [record, setRecord] = useState<ResourceOwnership | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [members, setMembers] = useState<OwnershipCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Guards against out-of-order responses when the panel's resource switches:
  // only the newest request may write state.
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setError(null);
    try {
      const next = await client.getResourceOwnership(resourceId);
      if (version !== refreshVersion.current) return;
      setRecord(next);
      setDraft(draftFrom(next));
      setLoaded(true);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, [client, resourceId]);

  useEffect(() => {
    // Resource switched: drop the previous one's record while the new fetch
    // runs, rather than showing it against the wrong resource.
    setRecord(null);
    setDraft(draftFrom(null));
    setLoaded(false);
    setSaved(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    // The member list only feeds the picker, so a failure degrades it to
    // "no members offered" rather than breaking the panel — the free-text
    // owner, purpose and ticket all still work.
    void client
      .listMembers()
      .then((next) => {
        if (!cancelled) setMembers(next);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const dirty = !draftsEqual(draft, draftFrom(record));

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
    setSaved(false);
  };

  const save = async () => {
    // Empty strings are sent as null: an emptied box means "remove this", and
    // the server treats an all-null patch as "stop tracking" and drops the row.
    const patch: ResourceOwnershipPatch = {
      resourceId,
      ownerUserId: draft.ownerUserId || null,
      ownerLabel: draft.ownerLabel.trim() || null,
      purpose: draft.purpose.trim() || null,
      ticketUrl: draft.ticketUrl.trim() || null,
    };
    const invalid = validateOwnershipPatch(patch);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const next = await client.saveResourceOwnership(patch);
      setRecord(next);
      setDraft(draftFrom(next));
      setSaved(true);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(`Remove the ownership record for ${resourceName}?`)) return;
    setBusy(true);
    setProblem(null);
    try {
      await client.clearResourceOwnership(resourceId);
      setRecord(null);
      setDraft(draftFrom(null));
      setSaved(false);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <p role="status" className="p-4 text-sm text-on-surface-faint">
        Loading ownership…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          Couldn&apos;t load ownership — {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-on-surface">Ownership</h3>
        <p className="mt-1 text-xs text-on-surface-secondary">
          Who to ask about this resource, and why it exists. The orphan finder shows the owner
          against every resource it flags, and alerts about this resource go to them as well as to
          the org.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface-secondary">Owner</span>
        <select
          value={draft.ownerUserId}
          onChange={(e) => update({ ownerUserId: e.target.value })}
          disabled={busy}
          className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
        >
          <option value="">No owner</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
          {/* A member who has since left the org is no longer in the list, but
              is still on the record. Offer them so opening and saving the form
              doesn't silently discard the owner. */}
          {record?.ownerUserId && !members.some((m) => m.userId === record.ownerUserId) && (
            <option value={record.ownerUserId}>
              {record.ownerName ?? record.ownerEmail ?? "Former member"} (no longer a member)
            </option>
          )}
        </select>
        <span className="text-xs text-on-surface-faint">
          Alerts about this resource are delivered to this person as well as to the org.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface-secondary">
          Or a team <span className="font-normal text-on-surface-faint">(optional)</span>
        </span>
        <input
          type="text"
          value={draft.ownerLabel}
          onChange={(e) => update({ ownerLabel: e.target.value })}
          disabled={busy}
          maxLength={OWNERSHIP_LIMITS.maxOwnerLabelLength}
          placeholder="Platform team"
          className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
        />
        <span className="text-xs text-on-surface-faint">
          Shown wherever the owner is, but nothing can be sent to it — set a person above if you
          want the alerts to reach someone.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface-secondary">Purpose</span>
        <textarea
          value={draft.purpose}
          onChange={(e) => update({ purpose: e.target.value })}
          disabled={busy}
          rows={3}
          maxLength={OWNERSHIP_LIMITS.maxPurposeLength}
          placeholder="Staging load tests for the checkout rewrite"
          className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface-secondary">Ticket</span>
        <input
          type="url"
          value={draft.ticketUrl}
          onChange={(e) => update({ ticketUrl: e.target.value })}
          disabled={busy}
          maxLength={OWNERSHIP_LIMITS.maxTicketUrlLength}
          placeholder="https://linear.app/acme/issue/ENG-482"
          className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
        />
        {record?.ticketUrl && (
          <a
            href={record.ticketUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-on-surface-tertiary underline hover:text-on-surface"
          >
            Open {formatTicketRef(record.ticketUrl)}
          </a>
        )}
      </label>

      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      {saved && !dirty && (
        <p role="status" className="text-sm text-on-surface-secondary">
          {record ? "Ownership saved." : "Ownership cleared — nothing was left to record."}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setDraft(draftFrom(record));
              setProblem(null);
            }}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface"
          >
            Discard changes
          </button>
        )}
        {record && !dirty && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="ml-auto rounded-lg px-3 py-1.5 text-sm text-on-surface-tertiary hover:text-danger"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

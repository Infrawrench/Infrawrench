import { useCallback, useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  ChangeDiffList,
  ChangeKindBadge,
  RevertChangeButton,
  type ResourceChangeEntry,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";
import { createWebChangeRevertClient } from "@/lib/changes-client";

interface ResourceChangesPanelProps {
  orgId: string;
  resourceId: string;
}

/**
 * The "Changes" tab body on a resource detail page — the resource's slice of
 * the org change timeline, recorded by the poller each sync cycle.
 */
export function ResourceChangesPanel({ orgId, resourceId }: ResourceChangesPanelProps) {
  const gt = useGT();
  const [entries, setEntries] = useState<ResourceChangeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const revertClient = useMemo(() => createWebChangeRevertClient(orgId), [orgId]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    apiGet<{ entries: ResourceChangeEntry[] }>(
      `/api/org/${orgId}/changes/resource?resourceId=${encodeURIComponent(resourceId)}`,
    )
      .then((r) => {
        if (!cancelled) setEntries(r.entries);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : gt("Failed to load changes"));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, resourceId, reloadKey]);

  if (error) {
    return <p className="p-6 text-sm text-danger">{error}</p>;
  }
  if (entries === null) {
    return <p className="p-6 text-sm text-on-surface-muted animate-pulse">{gt("Loading…")}</p>;
  }
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-on-surface-muted">
        <p>{gt("No changes recorded yet.")}</p>
        <T>
          <p className="text-xs text-on-surface-faint max-w-md text-center">
            The cloud poller compares each sync against the last stored snapshot and records
            anything that appeared, changed, or disappeared. New resources show their first events
            after a few poll cycles.
          </p>
        </T>
      </div>
    );
  }

  return (
    <ul className="p-6 space-y-4">
      {entries.map((entry) => (
        <li key={entry.id} className="border border-border rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <ChangeKindBadge kind={entry.changeKind} />
            <span className="text-xs text-on-surface-tertiary">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
            {entry.revertedAt && (
              <span
                className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary"
                title={gt("Reverted on {when}.", {
                  when: new Date(entry.revertedAt).toLocaleString(),
                })}
              >
                {gt("reverted")}
              </span>
            )}
            <RevertChangeButton
              entry={entry}
              client={revertClient}
              onReverted={reload}
              className="ml-auto"
            />
          </div>
          <ChangeDiffList entry={entry} />
        </li>
      ))}
    </ul>
  );
}

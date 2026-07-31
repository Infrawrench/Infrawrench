import { useEffect, useState } from "react";
import {
  CHANGE_KIND_LABELS,
  formatChangeValue,
  type ResourceChangeEntry,
  type ResourceChangeKind,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

const KIND_BADGE_CLASSES: Record<ResourceChangeKind, string> = {
  created: "bg-green-500/10 text-green-400",
  updated: "bg-blue-500/10 text-blue-400",
  deleted: "bg-red-500/10 text-red-400",
};

/** Small pill showing the change kind — shared by the tab and the org feed. */
export function ChangeKindBadge({ kind }: { kind: ResourceChangeKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_BADGE_CLASSES[kind]}`}
    >
      {CHANGE_KIND_LABELS[kind]}
    </span>
  );
}

/** Per-field before → after rows for an "updated" event. */
export function ChangeDiffList({ entry }: { entry: ResourceChangeEntry }) {
  if (entry.changeKind !== "updated" || entry.diff.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {entry.diff.map((d) => (
        <div key={d.field} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-mono text-on-surface-secondary">{d.field}</span>
          <span className="font-mono text-on-surface-faint line-through break-all">
            {formatChangeValue(d.from)}
          </span>
          <span className="text-on-surface-faint" aria-hidden>
            →
          </span>
          <span className="font-mono text-on-surface-tertiary break-all">
            {formatChangeValue(d.to)}
          </span>
        </div>
      ))}
    </div>
  );
}

interface ResourceChangesPanelProps {
  orgId: string;
  resourceId: string;
}

/**
 * The "Changes" tab body on a resource detail page — the resource's slice of
 * the org change timeline, recorded by the poller each sync cycle.
 */
export function ResourceChangesPanel({ orgId, resourceId }: ResourceChangesPanelProps) {
  const [entries, setEntries] = useState<ResourceChangeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load changes");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, resourceId]);

  if (error) {
    return <p className="p-6 text-sm text-red-400">{error}</p>;
  }
  if (entries === null) {
    return <p className="p-6 text-sm text-on-surface-muted animate-pulse">Loading…</p>;
  }
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-on-surface-muted">
        <p>No changes recorded yet.</p>
        <p className="text-xs text-on-surface-faint max-w-md text-center">
          The cloud poller compares each sync against the last stored snapshot and records anything
          that appeared, changed, or disappeared. New resources show their first events after a few
          poll cycles.
        </p>
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
          </div>
          <ChangeDiffList entry={entry} />
        </li>
      ))}
    </ul>
  );
}

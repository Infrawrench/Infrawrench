import { CHANGE_KIND_LABELS, formatChangeValue } from "@infrawrench/client-core";
import type { ResourceChangeEntry, ResourceChangeKind, ResourceFieldChange } from "./types.js";

const KIND_BADGE_CLASSES: Record<ResourceChangeKind, string> = {
  created: "bg-green-500/10 text-success",
  updated: "bg-blue-500/10 text-info",
  deleted: "bg-red-500/10 text-danger",
};

/**
 * Small pill showing the change kind. Shared by the org feed and the
 * per-resource Changes tab on both hosts, so "Appeared" is worded and coloured
 * once.
 */
export function ChangeKindBadge({ kind }: { kind: ResourceChangeKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_BADGE_CLASSES[kind]}`}
    >
      {CHANGE_KIND_LABELS[kind]}
    </span>
  );
}

/**
 * Per-field before → after rows.
 *
 * The renderer half of the drift feed, taking a bare `ResourceFieldChange[]`
 * so it is not tied to a change event: **IaC reconciliation** renders its
 * Terraform-state-vs-live diffs through this exact component, which is why it
 * exists apart from {@link ChangeDiffList}. One field diff, rendered one way.
 */
export function ResourceFieldDiffList({ diff }: { diff: readonly ResourceFieldChange[] }) {
  if (diff.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {diff.map((d) => (
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

/** Per-field before → after rows for an "updated" change event. */
export function ChangeDiffList({ entry }: { entry: ResourceChangeEntry }) {
  if (entry.changeKind !== "updated") return null;
  return <ResourceFieldDiffList diff={entry.diff} />;
}

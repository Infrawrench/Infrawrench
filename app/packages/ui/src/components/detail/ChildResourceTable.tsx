import { useMemo, useState } from "react";
import type { ChildTableColumn, ChildTableSchema } from "@infrawrench/plugin-base";
import { dnsRecordBadgeColor, formatDnsTtl } from "@infrawrench/plugin-base";
import type { ChildResource, ChildResourceGroup } from "./detail-types.js";
import { EditResourceModal } from "../EditResourceModal.js";

const BADGE_COLORS: Record<string, string> = {
  green:
    "bg-green-100 text-green-800 border border-green-300 dark:bg-green-900 dark:text-green-300 dark:border-green-700",
  yellow:
    "bg-yellow-100 text-yellow-800 border border-yellow-300 dark:bg-yellow-900 dark:text-yellow-300 dark:border-yellow-700",
  red: "bg-red-100 text-red-800 border border-red-300 dark:bg-red-900 dark:text-red-300 dark:border-red-700",
  blue: "bg-accent-muted text-accent-on-muted border border-accent-muted-border",
  gray: "bg-surface-overlay text-on-surface-tertiary border border-border-strong",
};

/**
 * Fixed pixel widths per column preset. `wide` returns undefined so the column
 * absorbs the remaining space in a `table-fixed` layout — it's the only
 * flexible column, and its content truncates rather than wrapping.
 */
function colWidth(width: ChildTableColumn["width"]): string | undefined {
  switch (width) {
    case "narrow":
      return "104px";
    case "auto":
      return "200px";
    case "wide":
      return undefined;
    default:
      return "160px";
  }
}

/** Formats whose values are short and fixed — never truncated/wrapped. */
const FIXED_FORMATS = new Set(["type-badge", "proxy-status", "ttl", "boolean-yesno"]);

function rawCellValue(col: ChildTableColumn, child: ChildResource): string {
  switch (col.source.kind) {
    case "field": {
      const v = child.fields?.[col.source.fieldKey];
      return v === undefined || v === null ? "" : String(v);
    }
    case "external-id":
      // ChildResource has no external id of its own; fall back to the row id.
      return child.id;
    case "display-name":
      return child.displayName;
  }
}

/** Strip a trailing `.suffix` (the zone name) so "www.example.com" → "www". */
function applySuffixStrip(value: string, suffix: string): string {
  if (!suffix) return value;
  if (value === suffix) return "@";
  const dotted = `.${suffix}`;
  if (value.endsWith(dotted)) return value.slice(0, -dotted.length);
  return value;
}

function ProxyIndicator({ proxied }: { proxied: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${
        proxied ? "text-orange-500" : "text-on-surface-faint"
      }`}
      title={proxied ? "Proxied through the CDN" : "DNS only"}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
      </svg>
      {proxied ? "Proxied" : "DNS only"}
    </span>
  );
}

function CellContent({ col, child }: { col: ChildTableColumn; child: ChildResource }) {
  const raw = rawCellValue(col, child);
  const value = col.stripSuffixFromFieldKey
    ? applySuffixStrip(raw, String(child.fields?.[col.stripSuffixFromFieldKey] ?? ""))
    : raw;

  switch (col.format) {
    case "type-badge": {
      const cls = BADGE_COLORS[dnsRecordBadgeColor(value)] ?? BADGE_COLORS["gray"];
      return (
        <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${cls}`}>
          {value}
        </span>
      );
    }
    case "proxy-status":
      return <ProxyIndicator proxied={raw === "true" || raw === "1"} />;
    case "ttl": {
      const n = Number(raw);
      return (
        <span className="text-on-surface-tertiary whitespace-nowrap">
          {Number.isNaN(n) ? raw : formatDnsTtl(n)}
        </span>
      );
    }
    case "boolean-yesno":
      return <span>{raw === "true" || raw === "1" ? "Yes" : "No"}</span>;
    // mono + plain text truncate to a single line within the fixed column
    // width; the full value is available on hover.
    case "mono":
      return (
        <span className="block truncate font-mono text-xs text-on-surface-secondary" title={value}>
          {value}
        </span>
      );
    default:
      return (
        <span className="block truncate text-on-surface-secondary" title={value}>
          {value}
        </span>
      );
  }
}

interface ChildResourceTableProps {
  spec: ChildTableSchema;
  group: ChildResourceGroup | undefined;
  onRowClick?: (child: ChildResource) => void;
  onCreate?: (group: ChildResourceGroup) => void;
  onDelete?: (child: ChildResource) => void | Promise<void>;
  /**
   * Submit handler for the inline edit form (used when `spec.onRowClick` is
   * "edit"). Receives only the changed fields. Throw to surface an error.
   */
  onEdit?: (child: ChildResource, changedFields: Record<string, string>) => Promise<void>;
}

/**
 * Dashboard-style table of a resource's child instances. Driven by a
 * {@link ChildTableSchema} from the plugin (column specs + formats) and the
 * host's already-loaded child group (the rows). Replaces the pill group for the
 * same resource type.
 */
export function ChildResourceTable({
  spec,
  group,
  onRowClick,
  onCreate,
  onDelete,
  onEdit,
}: ChildResourceTableProps) {
  const rows = group?.resources ?? [];
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChildResource | null>(null);
  const canCreate = !!group?.supportsCreate && !!onCreate;
  const canDelete = !!onDelete;
  // Edit mode requires the plugin to opt in AND the host to provide both a
  // submit handler and the child type's field schema.
  const editMode = spec.onRowClick === "edit" && !!onEdit && !!group?.fields;
  const clickable = spec.onRowClick !== "none";

  const handleRowClick = (child: ChildResource) => {
    if (editMode) setEditing(child);
    else if (spec.onRowClick !== "none") onRowClick?.(child);
  };

  const handleDelete = async (child: ChildResource) => {
    if (!onDelete) return;
    setDeleting(child.id);
    try {
      await onDelete(child);
    } finally {
      setDeleting(null);
    }
  };

  const createLabel = useMemo(
    () => spec.createLabel ?? `+ Create ${group?.displayName ?? "record"}`,
    [spec.createLabel, group?.displayName],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {spec.title}
        </h3>
        {canCreate && (
          <button
            type="button"
            onClick={() => group && onCreate?.(group)}
            className="text-xs text-on-surface-faint hover:text-accent transition-colors"
          >
            {createLabel}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-on-surface-faint">{spec.emptyText ?? "No items yet."}</p>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              {spec.columns.map((col) => {
                const w = colWidth(col.width);
                return <col key={col.key} {...(w ? { style: { width: w } } : {})} />;
              })}
              {canDelete && <col style={{ width: "84px" }} />}
            </colgroup>
            <thead>
              <tr className="bg-surface-overlay/50 border-b border-border">
                {spec.columns.map((col) => (
                  <th
                    key={col.key}
                    className="text-left font-medium text-on-surface-muted text-xs px-3 py-2 whitespace-nowrap"
                  >
                    {col.label}
                  </th>
                ))}
                {canDelete && <th className="px-3 py-2" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((child) => (
                <tr
                  key={child.id}
                  onClick={clickable ? () => handleRowClick(child) : undefined}
                  className={`border-b border-border last:border-0 ${
                    clickable ? "cursor-pointer hover:bg-surface-overlay/40" : ""
                  }`}
                >
                  {spec.columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-3 py-2 align-middle ${
                        FIXED_FORMATS.has(col.format ?? "") ? "whitespace-nowrap" : ""
                      }`}
                    >
                      <CellContent col={col} child={child} />
                    </td>
                  ))}
                  {canDelete && (
                    <td className="px-3 py-2 text-right align-middle">
                      <button
                        type="button"
                        disabled={deleting === child.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(child);
                        }}
                        className="text-xs text-on-surface-faint hover:text-red-400 transition-colors disabled:opacity-50"
                        title="Delete"
                      >
                        {deleting === child.id ? "…" : "Delete"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && onEdit && group?.fields && (
        <EditResourceModal
          displayName={group.displayName}
          fields={group.fields}
          initialValues={Object.fromEntries(
            Object.entries(editing.fields ?? {}).map(([k, v]) => [
              k,
              v === undefined || v === null ? "" : String(v),
            ]),
          )}
          onSubmit={async (changed) => {
            await onEdit(editing, changed);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

import { useState } from "react";
import type {
  SchemaNode,
  TextNode,
  BadgeNode,
  StatusDotNode,
  KeyValueListNode,
  ActionNode,
  GridNode,
  SectionNode,
  LinkNode,
  MetricChartNode,
  TableNode,
  KVItem,
  HostAction,
} from "@infrawrench/plugin-base";
import { MetricChart } from "../charts/MetricChart.js";
import { useUIStore } from "../../store/ui.store.js";
import {
  dispatchInvokePluginAction,
  dispatchNavigateToResource,
  dispatchPromptNoSqlCommand,
  dispatchRefreshResource,
} from "../../utils.js";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
      className={`flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded transition-colors ${
        copied
          ? "text-emerald-400 bg-emerald-500/10"
          : "text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-overlay"
      }`}
    >
      {copied ? (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5"
          aria-hidden="true"
        >
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-5A1.5 1.5 0 0 0 3 3.5v5A1.5 1.5 0 0 0 4.5 10H5" />
        </svg>
      )}
    </button>
  );
}

function useActionDispatch() {
  const { openReroll } = useUIStore();
  return (action: HostAction, resourceId?: string) => {
    switch (action.type) {
      case "reroll-secret":
        if (resourceId) openReroll(resourceId, action.fieldKey);
        break;
      case "open-url":
        window.open(action.url, "_blank", "noopener,noreferrer");
        break;
      case "copy-to-clipboard":
        // The value lookup is handled by the parent — this fires the copy
        break;
      case "navigate-to-resource":
        dispatchNavigateToResource({
          pluginId: action.pluginId,
          resourceTypeId: action.resourceTypeId,
          resourceId: action.resourceId,
        });
        break;
      case "refresh-resource":
        dispatchRefreshResource();
        break;
      case "plugin-action":
        dispatchInvokePluginAction({
          actionId: action.actionId,
          ...(action.confirmMessage ? { confirmMessage: action.confirmMessage } : {}),
          ...(action.successMessage ? { successMessage: action.successMessage } : {}),
        });
        break;
      case "prompt-nosql-command":
        dispatchPromptNoSqlCommand({
          command: action.command,
          fields: action.fields,
          ...(action.title ? { title: action.title } : {}),
          ...(action.description ? { description: action.description } : {}),
          ...(action.submitLabel ? { submitLabel: action.submitLabel } : {}),
          ...(action.danger ? { danger: action.danger } : {}),
        });
        break;
    }
  };
}

function TextNodeRenderer({ node }: { node: TextNode }) {
  const classes: Record<string, string> = {
    heading: "text-lg font-semibold text-on-surface",
    subheading: "text-sm font-medium text-on-surface-secondary",
    body: "text-sm text-on-surface-secondary",
    // Mono variants render as a block so multi-line content (rules, config
    // snippets, etc.) preserves its own whitespace and line breaks.
    mono: "text-xs font-mono text-on-surface-secondary whitespace-pre-wrap break-words block bg-surface-raised/50 rounded p-3 overflow-x-auto",
    muted: "text-xs text-on-surface-muted",
  };
  const cls = classes[node.variant ?? "body"] ?? classes["body"];
  if (node.variant === "mono") return <pre className={cls}>{node.content}</pre>;
  // Block <p> so sibling spacing (space-y-* on parent sections) actually
  // produces a visible gap — inline <span>s ignore vertical margins.
  return <p className={cls}>{node.content}</p>;
}

const BADGE_COLORS: Record<string, string> = {
  green:
    "bg-green-100 text-green-800 border border-green-300 dark:bg-green-900 dark:text-green-300 dark:border-green-700",
  yellow:
    "bg-yellow-100 text-yellow-800 border border-yellow-300 dark:bg-yellow-900 dark:text-yellow-300 dark:border-yellow-700",
  red: "bg-red-100 text-red-800 border border-red-300 dark:bg-red-900 dark:text-red-300 dark:border-red-700",
  blue: "bg-accent-muted text-accent-on-muted border border-accent-muted-border",
  gray: "bg-surface-overlay text-on-surface-tertiary border border-border-strong",
};

function BadgeNodeRenderer({ node }: { node: BadgeNode }) {
  const cls = BADGE_COLORS[node.color] ?? BADGE_COLORS["gray"];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {node.label}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  healthy: "bg-emerald-400",
  degraded: "bg-yellow-400",
  error: "bg-red-400",
  unknown: "bg-surface-sunken",
  provisioning: "bg-blue-400 animate-pulse",
  info: "bg-blue-400",
};

export function StatusDotNodeRenderer({ node }: { node: StatusDotNode }) {
  const dot = STATUS_COLORS[node.status] ?? STATUS_COLORS["unknown"];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
      {node.label && <span className="text-xs text-on-surface-tertiary">{node.label}</span>}
    </span>
  );
}

function KVItemRenderer({ item, resourceId }: { item: KVItem; resourceId?: string }) {
  const dispatch = useActionDispatch();
  const value =
    typeof item.value === "string" ? (
      <span className={item.sensitive ? "font-mono blur-sm hover:blur-none transition-all" : ""}>
        {item.value}
      </span>
    ) : (
      <span className="flex items-center gap-2">
        <span className="text-xs text-on-surface-muted italic">
          {item.value.resolution.kind === "output-ref"
            ? `from: ${item.value.resolution.sourceResourceId}`
            : "•••••"}
        </span>
        <button
          onClick={() => {
            const placeholder =
              item.value as import("@infrawrench/plugin-base").SecretValuePlaceholder;
            dispatch({ type: "reroll-secret", fieldKey: placeholder.fieldKey }, resourceId);
          }}
          className="text-xs text-accent hover:text-accent-on-muted transition-colors"
        >
          Reroll
        </button>
      </span>
    );

  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-border last:border-0">
      <span className="text-xs text-on-surface-muted flex-shrink-0 w-32">{item.key}</span>
      <span className="text-sm text-on-surface-secondary text-right flex-1">{value}</span>
      {item.copyable && typeof item.value === "string" && <CopyButton value={item.value} />}
    </div>
  );
}

function KeyValueListNodeRenderer({
  node,
  resourceId,
}: {
  node: KeyValueListNode;
  resourceId?: string;
}) {
  return (
    <div className="divide-y divide-border">
      {node.items.map((item, i) => (
        <KVItemRenderer key={i} item={item} resourceId={resourceId} />
      ))}
    </div>
  );
}

function ActionNodeRenderer({ node, resourceId }: { node: ActionNode; resourceId?: string }) {
  const dispatch = useActionDispatch();
  const variantClasses: Record<string, string> = {
    default: "bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary",
    danger:
      "bg-red-100 hover:bg-red-200 text-red-800 dark:bg-red-900 dark:hover:bg-red-800 dark:text-red-200",
    ghost: "bg-transparent hover:bg-surface-overlay text-on-surface-tertiary",
  };
  const cls = variantClasses[node.variant ?? "default"] ?? variantClasses["default"];
  return (
    <button
      onClick={() => dispatch(node.action, resourceId)}
      className={`px-3 py-1.5 rounded text-sm transition-colors ${cls}`}
    >
      {node.label}
    </button>
  );
}

function GridNodeRenderer({ node, resourceId }: { node: GridNode; resourceId?: string }) {
  const colClasses: Record<number, string> = {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-4",
  };
  const cls = colClasses[node.columns] ?? "grid-cols-2";
  return (
    <div className={`grid ${cls} gap-4`}>
      {node.items.map((item, i) => (
        <SchemaRenderer key={i} node={item} resourceId={resourceId} />
      ))}
    </div>
  );
}

function SectionNodeRenderer({ node, resourceId }: { node: SectionNode; resourceId?: string }) {
  return (
    <div className="space-y-3">
      {node.title && (
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {node.title}
        </h3>
      )}
      <div className="space-y-3">
        {node.children.map((child, i) => (
          <SchemaRenderer key={i} node={child} resourceId={resourceId} />
        ))}
      </div>
    </div>
  );
}

const TABLE_WIDTH_CLASS: Record<string, string> = {
  narrow: "w-24",
  wide: "w-auto",
  auto: "",
};

function TableNodeRenderer({ node, resourceId }: { node: TableNode; resourceId?: string }) {
  return (
    <div className="overflow-x-auto rounded border border-border bg-surface-overlay/40">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-surface-overlay/60">
            {node.columns.map((col) => (
              <th
                key={col.key}
                className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-on-surface-muted ${TABLE_WIDTH_CLASS[col.width ?? "auto"] ?? ""}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.length === 0 ? (
            <tr>
              <td
                colSpan={node.columns.length}
                className="px-4 py-4 text-center text-xs text-on-surface-muted"
              >
                No rows
              </td>
            </tr>
          ) : (
            node.rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-border last:border-0 hover:bg-surface-overlay/40 transition-colors"
              >
                {node.columns.map((col, colIdx) => {
                  const isFirst = colIdx === 0;
                  const emphasised = isFirst && node.emphasizeFirstColumn;
                  const cellValue = row.cells[col.key] ?? "";
                  const indent = isFirst && row.depth ? row.depth * 16 : 0;
                  const textCls = [
                    col.mono ? "font-mono" : "",
                    emphasised ? "text-on-surface font-medium" : "text-on-surface-secondary",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const isAction = typeof cellValue !== "string";
                  return (
                    <td key={col.key} className="px-4 py-3 align-top">
                      {isAction ? (
                        <ActionNodeRenderer node={cellValue} resourceId={resourceId} />
                      ) : (
                        <span
                          className={textCls}
                          style={indent ? { paddingLeft: `${indent}px` } : undefined}
                        >
                          {cellValue || <span className="text-on-surface-faint">—</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function LinkNodeRenderer({ node }: { node: LinkNode }) {
  return (
    <a
      href={node.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:text-accent-on-muted text-sm underline transition-colors"
    >
      {node.label}
    </a>
  );
}

interface SchemaRendererProps {
  node: SchemaNode;
  resourceId?: string;
}

export function SchemaRenderer({ node, resourceId }: SchemaRendererProps) {
  switch (node.kind) {
    case "text":
      return <TextNodeRenderer node={node} />;
    case "badge":
      return <BadgeNodeRenderer node={node} />;
    case "status-dot":
      return <StatusDotNodeRenderer node={node} />;
    case "key-value-list":
      return <KeyValueListNodeRenderer node={node} resourceId={resourceId} />;
    case "action":
      return <ActionNodeRenderer node={node} resourceId={resourceId} />;
    case "grid":
      return <GridNodeRenderer node={node} resourceId={resourceId} />;
    case "section":
      return <SectionNodeRenderer node={node} resourceId={resourceId} />;
    case "link":
      return <LinkNodeRenderer node={node} />;
    case "metric-chart":
      return <MetricChart node={node} />;
    case "table":
      return <TableNodeRenderer node={node} resourceId={resourceId} />;
    default:
      return null;
  }
}

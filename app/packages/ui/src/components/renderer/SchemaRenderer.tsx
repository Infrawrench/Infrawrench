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
  KVItem,
  HostAction,
} from "@infrawrench/plugin-base";
import { useUIStore } from "../../store/ui.store.js";

// ─── Action dispatcher ────────────────────────────────────────────────────────

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
        window.location.href = `/resources/${action.pluginId}/${action.resourceTypeId}/${action.resourceId}`;
        break;
      case "refresh-resource":
        window.location.reload();
        break;
    }
  };
}

// ─── Node renderers ───────────────────────────────────────────────────────────

function TextNodeRenderer({ node }: { node: TextNode }) {
  const classes: Record<string, string> = {
    heading: "text-lg font-semibold text-gray-100",
    subheading: "text-sm font-medium text-gray-300",
    body: "text-sm text-gray-200",
    mono: "text-sm font-mono text-gray-200",
    muted: "text-xs text-gray-500",
  };
  const cls = classes[node.variant ?? "body"] ?? classes["body"];
  return <span className={cls}>{node.content}</span>;
}

const BADGE_COLORS: Record<string, string> = {
  green: "bg-green-900 text-green-300 border border-green-700",
  yellow: "bg-yellow-900 text-yellow-300 border border-yellow-700",
  red: "bg-red-900 text-red-300 border border-red-700",
  blue: "bg-blue-900 text-blue-300 border border-blue-700",
  gray: "bg-gray-800 text-gray-400 border border-gray-700",
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
  healthy: "bg-blue-400",
  degraded: "bg-yellow-400",
  error: "bg-red-400",
  unknown: "bg-gray-500",
  provisioning: "bg-blue-400 animate-pulse",
};

export function StatusDotNodeRenderer({ node }: { node: StatusDotNode }) {
  const dot = STATUS_COLORS[node.status] ?? STATUS_COLORS["unknown"];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
      {node.label && <span className="text-xs text-gray-400">{node.label}</span>}
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
        <span className="text-xs text-gray-500 italic">
          {item.value.resolution.kind === "output-ref"
            ? `from: ${item.value.resolution.sourceResourceId}`
            : "•••••"}
        </span>
        <button
          onClick={() => {
            const placeholder = item.value as import("@infrawrench/plugin-base").SecretValuePlaceholder;
            dispatch({ type: "reroll-secret", fieldKey: placeholder.fieldKey }, resourceId);
          }}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          Reroll
        </button>
      </span>
    );

  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-gray-800 last:border-0">
      <span className="text-xs text-gray-500 flex-shrink-0 w-32">{item.key}</span>
      <span className="text-sm text-gray-200 text-right flex-1">{value}</span>
      {item.copyable && typeof item.value === "string" && (
        <button
          onClick={() => navigator.clipboard.writeText(item.value as string)}
          className="text-gray-600 hover:text-gray-400 text-xs flex-shrink-0"
          aria-label="Copy"
        >
          ⎘
        </button>
      )}
    </div>
  );
}

function KeyValueListNodeRenderer({ node, resourceId }: { node: KeyValueListNode; resourceId?: string }) {
  return (
    <div className="divide-y divide-gray-800">
      {node.items.map((item, i) => (
        <KVItemRenderer key={i} item={item} resourceId={resourceId} />
      ))}
    </div>
  );
}

function ActionNodeRenderer({ node, resourceId }: { node: ActionNode; resourceId?: string }) {
  const dispatch = useActionDispatch();
  const variantClasses: Record<string, string> = {
    default: "bg-gray-800 hover:bg-gray-700 text-gray-200",
    danger: "bg-red-900 hover:bg-red-800 text-red-200",
    ghost: "bg-transparent hover:bg-gray-800 text-gray-400",
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {node.title}
        </h3>
      )}
      <div className="space-y-2">
        {node.children.map((child, i) => (
          <SchemaRenderer key={i} node={child} resourceId={resourceId} />
        ))}
      </div>
    </div>
  );
}

function LinkNodeRenderer({ node }: { node: LinkNode }) {
  return (
    <a
      href={node.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 hover:text-blue-300 text-sm underline transition-colors"
    >
      {node.label}
    </a>
  );
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

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
    default:
      return null;
  }
}

import { useEffect, useMemo, useState } from "react";
import { useDraggable, useDndMonitor, useDroppable } from "@dnd-kit/core";
import type {
  PeerPaneResource,
  PeerPaneResourceGroup,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { StatusDotNodeRenderer, type PeerPaneData } from "@infrawrench/ui";
import type { DraggableResource } from "../lib/pins";
import { invoke } from "../lib/invoke";
import { getPlugin } from "../plugins/loader";
import { formatErrorMessage } from "../lib/errors";
import { CreateResourceModal } from "./CreateResourceModal";
import { ErrorNotice } from "./ErrorNotice";
import { K8sExecPanel } from "./K8sExecPanel";
import { K9sTerminal } from "./K9sTerminal";
import { SecretExportModal } from "./SecretExportModal";
import { buildPluginHostServices } from "../lib/sql-drivers";

interface PeerPaneViewProps {
  pane: PeerPaneData;
  accountId: string;
  parentResourceId: string;
}

export function PeerPaneView({ pane, accountId, parentResourceId }: PeerPaneViewProps) {
  const [resourceGroups, setResourceGroups] = useState(pane.schema.resourceGroups);
  const [execTarget, setExecTarget] = useState<{
    resource: PeerPaneResource;
    group: PeerPaneResourceGroup;
  } | null>(null);
  const [k9sOpen, setK9sOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<PeerPaneResourceGroup | null>(null);
  const [k9sInstalled, setK9sInstalled] = useState<boolean | null>(null);
  const [createResourceType, setCreateResourceType] = useState<ResourceTypeDefinition | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secretExportSource, setSecretExportSource] = useState<DraggableResource | null>(null);
  const [nsFilter, setNsFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    setResourceGroups(pane.schema.resourceGroups);
  }, [pane]);

  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("k9s_check")
      .then((installed) => {
        if (!cancelled) setK9sInstalled(installed);
      })
      .catch(() => {
        if (!cancelled) setK9sInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!createTarget) {
      setCreateResourceType(null);
      setCreateError(null);
      return;
    }

    void (async () => {
      try {
        setCreateError(null);
        const loaded = await getPlugin(createTarget.pluginId);
        const resourceType = loaded?.plugin.resourceTypes.find(
          (typeDef) => typeDef.id === createTarget.resourceTypeId,
        );
        if (!resourceType) {
          throw new Error(`Resource type "${createTarget.resourceTypeId}" not found`);
        }
        if (!cancelled) setCreateResourceType(resourceType);
      } catch (error) {
        if (!cancelled) {
          setCreateResourceType(null);
          setCreateError(formatErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [createTarget]);

  const supportsSecretImport = !!pane.schema.supportsSecretImport;
  const droppableId = `secret-import:${accountId}:${parentResourceId}`;
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: droppableId });

  useDndMonitor({
    onDragEnd(event) {
      if (!supportsSecretImport) return;
      if (String(event.over?.id) !== droppableId) return;
      const resource = event.active.data.current?.resource as DraggableResource | undefined;
      if (resource) setSecretExportSource(resource);
    },
  });

  const kubeconfig = pane.credentials["kubeconfig"];
  const showK9sAction = !!pane.schema.supportsK9s;
  const canOpenK9s = showK9sAction && !!kubeconfig;
  const k9sLabel =
    k9sInstalled === null
      ? "Checking k9s…"
      : k9sInstalled
        ? "Open in k9s"
        : "k9s not installed";

  // Derive available namespaces from all resource groups (skip namespace group itself)
  const namespaces = useMemo(() => {
    const nsSet = new Set<string>();
    for (const group of resourceGroups) {
      if (group.resourceTypeId === "k8s-namespace") continue;
      for (const item of group.items) {
        const ns = item.namespace ?? String(item.fields["namespace"] ?? "");
        if (ns) nsSet.add(ns);
      }
    }
    return Array.from(nsSet).sort();
  }, [resourceGroups]);

  // Apply namespace filter to all groups (namespace group itself is special-cased)
  const filteredGroups = useMemo(() => {
    if (!nsFilter) return resourceGroups;
    return resourceGroups.map((group) => {
      if (group.resourceTypeId === "k8s-namespace") {
        // Highlight the selected namespace in the namespace group
        return {
          ...group,
          items: group.items.filter(
            (item) => item.displayName === nsFilter,
          ),
        };
      }
      return {
        ...group,
        items: group.items.filter((item) => {
          const ns = item.namespace ?? String(item.fields["namespace"] ?? "");
          return ns === nsFilter;
        }),
      };
    });
  }, [resourceGroups, nsFilter]);

  // Groups that have items after filtering (never hide empty groups with supportsCreate)
  const visibleGroups = filteredGroups.filter(
    (g) => g.items.length > 0 || g.supportsCreate,
  );

  const createClientFactory = useMemo(
    () =>
      createTarget
        ? async () => {
            const loaded = await getPlugin(createTarget.pluginId);
            if (!loaded) throw new Error(`Plugin "${createTarget.pluginId}" not loaded`);
            const services = buildPluginHostServices(loaded.plugin.manifest, pane.credentials);
            return loaded.plugin.createClient(pane.credentials, services);
          }
        : undefined,
    [createTarget, pane.credentials],
  );

  function toggleGroupCollapsed(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div
      ref={setDropRef}
      className={`space-y-3 transition-colors rounded-xl ${isOver && supportsSecretImport ? "ring-2 ring-blue-500/50 bg-blue-500/5" : ""}`}
      data-parent-resource-id={parentResourceId}
    >
      {/* Header: status + actions */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {pane.schema.status && (
            <StatusDotNodeRenderer node={pane.schema.status} />
          )}
          {/* Namespace filter */}
          {namespaces.length > 1 && (
            <select
              value={nsFilter ?? ""}
              onChange={(e) => setNsFilter(e.target.value || null)}
              className="text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500 transition-colors"
            >
              <option value="">All namespaces ({namespaces.length})</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          )}
        </div>
        {showK9sAction && (
          <button
            onClick={() => {
              if (canOpenK9s) setK9sOpen(true);
            }}
            disabled={!canOpenK9s}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-400 disabled:hover:bg-gray-800 text-sm font-medium text-white transition-colors"
          >
            {k9sLabel}
          </button>
        )}
      </div>

      {createError && (
        <ErrorNotice
          message={createError}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
          textClassName="text-sm text-red-200"
        />
      )}

      {visibleGroups.map((group) => {
        const groupKey = `${group.pluginId}:${group.resourceTypeId}`;
        const isNamespaceGroup = group.resourceTypeId === "k8s-namespace";
        const isCollapsed = collapsedGroups.has(groupKey);
        const itemCount = group.items.length;

        // When filtering by namespace, skip the namespace group entirely
        if (isNamespaceGroup && nsFilter) return null;

        return (
          <section
            key={groupKey}
            className="rounded-2xl border border-gray-800 bg-gray-900/40 overflow-hidden"
          >
            <div
              className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none hover:bg-gray-800/30 transition-colors"
              onClick={() => toggleGroupCollapsed(groupKey)}
            >
              <div className="flex items-center gap-2">
                <span className={`text-gray-500 text-xs transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
                  ▶
                </span>
                <h3 className="text-sm font-semibold text-gray-100">
                  {getGroupDisplayTitle(group.title, itemCount)}
                </h3>
                {isNamespaceGroup && (
                  <span className="text-xs text-gray-500">
                    {group.items.filter((ns) => ns.fields["system"] !== "true").length} user
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {group.supportsCreate && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setCreateTarget(group); }}
                    className="px-2.5 py-1 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-200 hover:border-gray-600 hover:bg-gray-700 transition-colors"
                  >
                    Create {getCreateLabel(group.title)}
                  </button>
                )}
              </div>
            </div>

            {!isCollapsed && itemCount > 0 && (
              <div className="px-4 pb-3">
                {isNamespaceGroup ? (
                  <NamespaceGrid
                    items={group.items}
                    activeNamespace={nsFilter}
                    onSelect={(ns) => setNsFilter(nsFilter === ns ? null : ns)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {group.items.map((resource) => (
                      <ResourcePill
                        key={resource.id}
                        pane={pane}
                        group={group}
                        resource={resource}
                        accountId={accountId}
                        onExec={() => setExecTarget({ resource, group })}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isCollapsed && itemCount === 0 && (
              <div className="px-4 pb-3">
                <p className="text-sm text-gray-500">No resources found.</p>
              </div>
            )}
          </section>
        );
      })}

      {k9sOpen && kubeconfig && (
        <TerminalOverlay title="k9s" onClose={() => setK9sOpen(false)}>
          <K9sTerminal kubeconfig={kubeconfig} />
        </TerminalOverlay>
      )}

      {execTarget && kubeconfig && (
        <TerminalOverlay
          title={`Exec: ${execTarget.resource.displayName}`}
          onClose={() => setExecTarget(null)}
        >
          <K8sExecPanel
            kubeconfig={kubeconfig}
            namespace={execTarget.resource.namespace ?? "default"}
            podName={execTarget.resource.displayName}
            {...(execTarget.resource.containerName
              ? { containerName: execTarget.resource.containerName }
              : {})}
          />
        </TerminalOverlay>
      )}

      {createTarget && createResourceType && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={createTarget.pluginId}
          resourceType={createResourceType}
          {...(createClientFactory ? { clientFactory: createClientFactory } : {})}
          onClose={() => setCreateTarget(null)}
          onCreated={(created) => {
            setResourceGroups((prev) =>
              prev.map((group) =>
                group.resourceTypeId === createTarget.resourceTypeId
                  ? {
                      ...group,
                      title: replaceTrailingCount(group.title, group.items.length + 1),
                      items: [toPeerPaneResource(created), ...group.items],
                    }
                  : group,
              ),
            );
            setCreateTarget(null);
          }}
        />
      )}

      {secretExportSource && (
        <SecretExportModal
          source={secretExportSource}
          targetPluginId={pane.schema.resourceGroups[0]?.pluginId ?? "kubernetes"}
          targetCredentials={pane.credentials}
          onClose={() => setSecretExportSource(null)}
          onCreated={() => setSecretExportSource(null)}
        />
      )}

      {isOver && supportsSecretImport && (
        <div className="rounded-xl border-2 border-dashed border-blue-500/40 bg-blue-500/5 px-4 py-6 text-center">
          <p className="text-sm font-medium text-blue-300">Drop to create K8s Secret</p>
          <p className="text-xs text-blue-400/60 mt-1">Secret keys will be created from the resource's outputs</p>
        </div>
      )}
    </div>
  );
}

// ── Namespace grid ────────────────────────────────────────────────────────

function NamespaceGrid({
  items,
  activeNamespace,
  onSelect,
}: {
  items: PeerPaneResource[];
  activeNamespace: string | null;
  onSelect: (ns: string) => void;
}) {
  const userNs = items.filter((ns) => ns.fields["system"] !== "true");
  const systemNs = items.filter((ns) => ns.fields["system"] === "true");
  const [showSystem, setShowSystem] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {userNs.map((ns) => (
          <button
            key={ns.id}
            onClick={() => onSelect(ns.displayName)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              activeNamespace === ns.displayName
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100"
            }`}
          >
            {ns.displayName}
            {ns.status && (
              <span
                className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full ${statusClassName(ns.status)}`}
              />
            )}
          </button>
        ))}
      </div>
      {systemNs.length > 0 && (
        <div>
          <button
            onClick={() => setShowSystem(!showSystem)}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            {showSystem ? "Hide" : "Show"} {systemNs.length} system namespace{systemNs.length === 1 ? "" : "s"}
          </button>
          {showSystem && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {systemNs.map((ns) => (
                <button
                  key={ns.id}
                  onClick={() => onSelect(ns.displayName)}
                  className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                    activeNamespace === ns.displayName
                      ? "bg-blue-600/60 text-blue-100"
                      : "bg-gray-800/50 text-gray-500 hover:bg-gray-700/50 hover:text-gray-400"
                  }`}
                >
                  {ns.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Resource pill ─────────────────────────────────────────────────────────

function ResourcePill({
  pane,
  group,
  resource,
  accountId,
  onExec,
}: {
  pane: PeerPaneData;
  group: PeerPaneResourceGroup;
  resource: PeerPaneResource;
  accountId: string;
  onExec: () => void;
}) {
  const draggableResource: DraggableResource = {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: group.resourceTypeId,
    accountId,
    displayName: resource.displayName,
    fields: resource.fields,
    externalId: resource.externalId,
  };

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: resource.id,
    data: {
      resource: draggableResource,
      dragLabel: resource.displayName,
    },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group flex items-center gap-2 rounded-full border border-gray-700 bg-gray-900 px-3 py-2 cursor-grab active:cursor-grabbing transition-colors ${
        isDragging ? "opacity-40" : "hover:border-gray-600"
      }`}
    >
      <span
        className="w-4 h-4 flex-shrink-0"
        dangerouslySetInnerHTML={{ __html: pane.pluginLogoSvg }}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-100 truncate">{resource.displayName}</span>
          {resource.status && (
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${statusClassName(resource.status)}`}
              aria-hidden
            />
          )}
        </div>
        {resource.subtitle && (
          <p className="text-xs text-gray-500 truncate">{resource.subtitle}</p>
        )}
      </div>
      {resource.supportsExec && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onExec();
          }}
          className="ml-1 w-6 h-6 rounded-full bg-gray-800 hover:bg-gray-700 text-xs text-gray-200 transition-colors"
          title="Open exec terminal"
        >
          ▶
        </button>
      )}
    </div>
  );
}

// ── Terminal overlay ──────────────────────────────────────────────────────

function TerminalOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function replaceTrailingCount(title: string, count: number): string {
  return /\(\d+\)$/.test(title)
    ? title.replace(/\(\d+\)$/, `(${count})`)
    : title;
}

function getGroupDisplayTitle(title: string, itemCount: number): string {
  // Replace the count in titles like "Pods (5)" with the filtered count
  if (/\(\d+\)$/.test(title)) {
    return title.replace(/\(\d+\)$/, `(${itemCount})`);
  }
  return `${title} (${itemCount})`;
}

function getCreateLabel(title: string): string {
  return title
    .replace(/\(\d+\)$/, "")
    .trim()
    .replace(/s$/i, "");
}

function toPeerPaneResource(resource: ResourceInstance): PeerPaneResource {
  const namespace = String(resource.fields["namespace"] ?? "");
  const image = String(resource.fields["image"] ?? "");
  const status = String(resource.fields["status"] ?? "");
  const replicas = resource.fields["replicas"];

  return {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    displayName: resource.displayName,
    subtitle:
      resource.resourceTypeId === "k8s-namespace"
        ? "Active"
        : resource.resourceTypeId === "k8s-pod"
          ? [namespace, image].filter(Boolean).join(" · ")
          : [namespace, replicas != null ? `${String(replicas)} replicas` : ""]
              .filter(Boolean)
              .join(" · "),
    fields: resource.fields,
    namespace,
    ...(resource.resourceTypeId === "k8s-pod" ? { status: mapPeerStatus(status) } : {}),
    ...(resource.externalId ? { externalId: resource.externalId } : {}),
    ...(resource.resourceTypeId === "k8s-pod" ? { supportsExec: true } : {}),
    ...(resource.fields["containerName"]
      ? { containerName: String(resource.fields["containerName"]) }
      : {}),
  };
}

function mapPeerStatus(
  status: string,
): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
  switch (status.toLowerCase()) {
    case "running":
    case "ready":
    case "active":
    case "succeeded":
      return "healthy";
    case "pending":
    case "creating":
    case "containercreating":
      return "provisioning";
    case "crashloopbackoff":
    case "terminating":
    case "evicted":
      return "degraded";
    case "failed":
    case "error":
    case "imagepullbackoff":
    case "errimagepull":
    case "oomkilled":
      return "error";
    default:
      return "unknown";
  }
}

function statusClassName(status: NonNullable<PeerPaneResource["status"]>): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-400";
    case "degraded":
      return "bg-amber-400";
    case "error":
      return "bg-red-400";
    case "provisioning":
      return "bg-blue-400";
    case "unknown":
    default:
      return "bg-gray-500";
  }
}

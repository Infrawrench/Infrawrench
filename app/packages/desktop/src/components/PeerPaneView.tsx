import { useEffect, useMemo, useState, useCallback } from "react";
import { useDraggable, useDndContext, useDndMonitor, useDroppable } from "@dnd-kit/core";
import type {
  PeerPaneResource,
  PeerPaneResourceGroup,
  ResourceInstance,
  ResourceTypeDefinition,
  PluginClient,
} from "@infrawrench/plugin-base";
import { StatusDotNodeRenderer, ManifestEditorView, type PeerPaneData } from "@infrawrench/ui";
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

interface PortForwardEntry {
  sessionId: string;
  localPort: number;
  remotePort: number;
  resourceName: string;
  namespace: string;
}

export function PeerPaneView({ pane, accountId, parentResourceId }: PeerPaneViewProps) {
  const [resourceGroups, setResourceGroups] = useState(pane.schema.resourceGroups);
  const [execTarget, setExecTarget] = useState<{
    resource: PeerPaneResource;
    group: PeerPaneResourceGroup;
    /** When true, the pod is auto-deleted when the terminal closes */
    ephemeral?: boolean;
  } | null>(null);
  const [k9sOpen, setK9sOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<PeerPaneResourceGroup | null>(null);
  const [k9sInstalled, setK9sInstalled] = useState<boolean | null>(null);
  const [createResourceType, setCreateResourceType] = useState<ResourceTypeDefinition | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secretExportSource, setSecretExportSource] = useState<DraggableResource | null>(null);
  const [nsFilter, setNsFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // ── Manifest editor state ──────────────────────────────────────────────
  const [manifestTarget, setManifestTarget] = useState<{
    resource: PeerPaneResource;
    group: PeerPaneResourceGroup;
  } | null>(null);
  const [pluginClient, setPluginClient] = useState<PluginClient | null>(null);

  // Build a plugin client when we need it (for manifest fetching)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Grab the first group's pluginId (they're all from the same plugin in K8s peer panes)
        const pluginId = pane.schema.resourceGroups[0]?.pluginId;
        if (!pluginId) return;
        const loaded = await getPlugin(pluginId);
        if (!loaded || cancelled) return;
        const services = buildPluginHostServices(loaded.plugin.manifest, pane.credentials);
        const client = loaded.plugin.createClient(pane.credentials, services);
        if (!cancelled) setPluginClient(client);
      } catch {
        // non-critical — manifest tab just won't work
      }
    })();
    return () => { cancelled = true; };
  }, [pane.credentials, pane.schema.resourceGroups]);

  const handleGetManifest = useCallback(async (): Promise<string> => {
    if (!pluginClient?.getManifest || !manifestTarget) {
      throw new Error("Manifest viewing not supported");
    }
    return pluginClient.getManifest(manifestTarget.resource.id, accountId);
  }, [pluginClient, manifestTarget, accountId]);

  const handleApplyManifest = useCallback(async (manifest: string): Promise<void> => {
    if (!pluginClient?.applyManifest || !manifestTarget) {
      throw new Error("Manifest editing not supported");
    }
    await pluginClient.applyManifest(manifestTarget.resource.id, accountId, manifest);
  }, [pluginClient, manifestTarget, accountId]);

  // ── Port forward state ─────────────────────────────────────────────────
  const [portForwards, setPortForwards] = useState<PortForwardEntry[]>([]);
  const [pfStarting, setPfStarting] = useState<string | null>(null); // resource ID currently starting
  const [pfError, setPfError] = useState<string | null>(null);

  async function handleStartPortForward(resource: PeerPaneResource) {
    const kubeconfig = pane.credentials["kubeconfig"];
    if (!kubeconfig) return;

    const namespace = resource.namespace ?? String(resource.fields["namespace"] ?? "default");
    const portsStr = String(resource.fields["ports"] ?? "");
    // Parse first port from "80/TCP, 443/TCP" format
    const firstPort = Number(portsStr.split("/")[0]);
    if (!firstPort || isNaN(firstPort)) {
      setPfError(`Cannot determine port for ${resource.displayName}`);
      return;
    }

    setPfStarting(resource.id);
    setPfError(null);
    try {
      const result = await invoke<{ sessionId: string; localPort: number }>(
        "k8s_pf_start",
        {
          kubeconfig,
          namespace,
          resourceType: "svc",
          resourceName: resource.displayName,
          remotePort: firstPort,
          localPort: 0,
        },
      );

      setPortForwards((prev) => [
        ...prev,
        {
          sessionId: result.sessionId,
          localPort: result.localPort,
          remotePort: firstPort,
          resourceName: resource.displayName,
          namespace,
        },
      ]);

      // Listen for exit to remove from the list
      window.electronAPI.on(`k8s_pf_exit_${result.sessionId}`, () => {
        setPortForwards((prev) => prev.filter((pf) => pf.sessionId !== result.sessionId));
        window.electronAPI.offAll(`k8s_pf_exit_${result.sessionId}`);
      });
    } catch (err) {
      setPfError(formatErrorMessage(err));
    } finally {
      setPfStarting(null);
    }
  }

  function handleStopPortForward(sessionId: string) {
    void invoke("k8s_pf_stop", { sessionId });
    setPortForwards((prev) => prev.filter((pf) => pf.sessionId !== sessionId));
    window.electronAPI.offAll(`k8s_pf_exit_${sessionId}`);
  }

  // Clean up port forwards on unmount
  useEffect(() => {
    return () => {
      for (const pf of portForwards) {
        void invoke("k8s_pf_stop", { sessionId: pf.sessionId });
        window.electronAPI.offAll(`k8s_pf_exit_${pf.sessionId}`);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Disable drop target when the dragged resource is already in this cluster —
  // creating a secret for something that's already here makes no sense.
  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const dragFromSameCluster = activeResource?.accountId === accountId;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: droppableId,
    disabled: dragFromSameCluster,
  });

  useDndMonitor({
    onDragEnd(event) {
      if (!supportsSecretImport) return;
      if (String(event.over?.id) !== droppableId) return;
      const resource = event.active.data.current?.resource as DraggableResource | undefined;
      if (!resource) return;
      // Ignore drops from within the same cluster
      if (resource.accountId === accountId) return;
      setSecretExportSource(resource);
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

  // Provisioning state: no resource groups and status is provisioning
  const isProvisioning =
    pane.schema.status?.status === "provisioning" &&
    resourceGroups.length === 0;

  if (isProvisioning) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center space-y-4">
        <div className="w-10 h-10 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-gray-200">Cluster is provisioning</p>
          <p className="text-xs text-gray-500 max-w-xs">
            Workloads will appear here once the cluster is ready. This usually takes a few minutes.
          </p>
        </div>
      </div>
    );
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
                        onClick={() => setManifestTarget({ resource, group })}
                        onPortForward={
                          group.resourceTypeId === "k8s-service" && resource.fields["hasSelector"] === "true"
                            ? () => handleStartPortForward(resource)
                            : undefined
                        }
                        isPortForwarding={pfStarting === resource.id}
                        activePortForward={portForwards.find(
                          (pf) => pf.resourceName === resource.displayName
                            && pf.namespace === (resource.namespace ?? String(resource.fields["namespace"] ?? "default")),
                        )}
                        onStopPortForward={(sessionId) => handleStopPortForward(sessionId)}
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
          title={
            execTarget.ephemeral
              ? `Scratch: ${execTarget.resource.displayName}`
              : `Exec: ${execTarget.resource.displayName}`
          }
          onClose={() => {
            if (execTarget.ephemeral && pluginClient?.deleteResource) {
              // Auto-delete the ephemeral pod and remove from the list
              const resourceId = execTarget.resource.id;
              const groupTypeId = execTarget.group.resourceTypeId;
              pluginClient
                .deleteResource(execTarget.resource.resourceTypeId, resourceId, accountId)
                .catch(() => { /* silently ignore cleanup errors */ });
              setResourceGroups((prev) =>
                prev.map((group) =>
                  group.resourceTypeId === groupTypeId
                    ? {
                        ...group,
                        title: replaceTrailingCount(group.title, Math.max(0, group.items.length - 1)),
                        items: group.items.filter((item) => item.id !== resourceId),
                      }
                    : group,
                ),
              );
            }
            setExecTarget(null);
          }}
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
            const peerResource = toPeerPaneResource(created);
            const isEphemeralPod =
              createTarget.resourceTypeId === "k8s-pod" &&
              created.fields["ephemeral"] === "true";

            setResourceGroups((prev) =>
              prev.map((group) =>
                group.resourceTypeId === createTarget.resourceTypeId
                  ? {
                      ...group,
                      title: replaceTrailingCount(group.title, group.items.length + 1),
                      items: [peerResource, ...group.items],
                    }
                  : group,
              ),
            );

            // Auto-open exec terminal for ephemeral scratch pods
            if (isEphemeralPod) {
              setExecTarget({
                resource: { ...peerResource, supportsExec: true, containerName: "scratch" },
                group: createTarget,
                ephemeral: true,
              });
            }

            setCreateTarget(null);
          }}
        />
      )}

      {manifestTarget && pluginClient?.getManifest && (
        <TerminalOverlay
          title={`${manifestTarget.resource.displayName} — Manifest`}
          onClose={() => setManifestTarget(null)}
        >
          <ManifestEditorView
            capability={{
              language: "yaml",
              resourceKind: manifestTarget.group.title.replace(/\s*\(\d+\)$/, "").replace(/s$/i, ""),
            }}
            onGetManifest={handleGetManifest}
            onApplyManifest={pluginClient.applyManifest ? handleApplyManifest : undefined}
          />
        </TerminalOverlay>
      )}

      {/* Active port forwards status bar */}
      {portForwards.length > 0 && (
        <div className="space-y-1.5">
          {portForwards.map((pf) => (
            <div
              key={pf.sessionId}
              className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-2.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                <span className="text-sm text-gray-200 font-medium truncate">
                  {pf.resourceName}
                </span>
                <span className="text-xs text-gray-500">
                  {pf.namespace}
                </span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(`localhost:${pf.localPort}`);
                  }}
                  className="text-xs font-mono text-emerald-300 hover:text-emerald-200 transition-colors"
                  title="Click to copy"
                >
                  localhost:{pf.localPort} → {pf.remotePort}
                </button>
                <button
                  onClick={() => handleStopPortForward(pf.sessionId)}
                  className="px-2 py-0.5 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  Stop
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pfError && (
        <ErrorNotice
          message={pfError}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
          textClassName="text-sm text-red-200"
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
  onClick,
  onPortForward,
  isPortForwarding,
  activePortForward,
  onStopPortForward,
}: {
  pane: PeerPaneData;
  group: PeerPaneResourceGroup;
  resource: PeerPaneResource;
  accountId: string;
  onExec: () => void;
  onClick?: () => void;
  onPortForward?: () => void;
  isPortForwarding?: boolean;
  activePortForward?: PortForwardEntry;
  onStopPortForward?: (sessionId: string) => void;
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
      className={`group flex items-center gap-2 rounded-full border bg-gray-900 px-3 py-2 cursor-grab active:cursor-grabbing transition-colors ${
        activePortForward
          ? "border-emerald-500/40"
          : isDragging
            ? "opacity-40 border-gray-700"
            : "border-gray-700 hover:border-gray-600"
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
        {activePortForward && (
          <p className="text-xs text-emerald-400 font-mono truncate">
            :{activePortForward.localPort} → :{activePortForward.remotePort}
          </p>
        )}
      </div>
      {/* Manifest editor button */}
      {onClick && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className="ml-1 w-6 h-6 rounded-full bg-gray-800 hover:bg-gray-700 text-xs text-gray-200 transition-colors"
          title="View manifest"
        >
          { /* code/braces icon */ }
          {"{ }"}
        </button>
      )}
      {/* Port forward button for services */}
      {onPortForward && !activePortForward && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onPortForward();
          }}
          disabled={isPortForwarding}
          className="ml-1 h-6 px-2 rounded-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-xs text-gray-200 transition-colors whitespace-nowrap"
          title="Port forward"
        >
          {isPortForwarding ? "…" : "⇌"}
        </button>
      )}
      {/* Stop port forward */}
      {activePortForward && onStopPortForward && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onStopPortForward(activePortForward.sessionId);
          }}
          className="ml-1 w-6 h-6 rounded-full bg-red-900/50 hover:bg-red-800/50 text-xs text-red-300 transition-colors"
          title="Stop port forward"
        >
          ■
        </button>
      )}
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

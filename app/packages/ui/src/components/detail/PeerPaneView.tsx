import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDraggable, useDndContext, useDndMonitor, useDroppable } from "@dnd-kit/core";
import { useGT } from "gt-react";
import type { PeerPaneResource, PeerPaneResourceGroup } from "@infrawrench/plugin-base";
import type { DraggableResource } from "../../dnd/types.js";
import { ErrorNotice } from "../ErrorNotice.js";
import { ImportYamlModal } from "../ImportYamlModal.js";
import type { PeerPaneData } from "./detail-types.js";
import { statusDotClass } from "../schema-tokens.js";
import { dispatchPromptNoSqlCommand } from "../../utils.js";
import { useDataString } from "../../i18n/data-strings.js";

export interface PeerPanePortForwardEntry {
  sessionId: string;
  localPort: number;
  remotePort: number;
  resourceName: string;
  namespace: string;
}

export interface PeerPaneViewProps {
  pane: PeerPaneData;
  accountId: string;
  parentResourceId: string;

  /** Navigate to a pill's resource detail. */
  onOpenPill: (resource: PeerPaneResource, group: PeerPaneResourceGroup) => void;

  /** Optional: enables "Import YAML" header action. */
  onImportYaml?: (yaml: string) => Promise<{ applied: number }>;

  /** Optional: opens host-provided k9s/terminal overlay. If omitted, button is hidden. */
  k9s?: {
    label: string;
    disabled?: boolean;
    onOpen: () => void;
  };

  /** Optional: host-provided "Create" handler. If omitted, create buttons are hidden. */
  onCreate?: (group: PeerPaneResourceGroup) => void;

  /** Optional: enables per-pod exec button in pills. */
  onExec?: (resource: PeerPaneResource, group: PeerPaneResourceGroup) => void;

  /** Optional: enables port-forward button on services. */
  portForward?: {
    entries: PeerPanePortForwardEntry[];
    /** Resource id currently being started */
    starting: string | null;
    error: string | null;
    onStart: (resource: PeerPaneResource) => void;
    onStop: (sessionId: string) => void;
  };

  /** Optional: enables secret-import drop target. */
  onSecretDrop?: (source: DraggableResource) => void;
}

export function PeerPaneView({
  pane,
  accountId,
  parentResourceId,
  onOpenPill,
  onImportYaml,
  k9s,
  onCreate,
  onExec,
  portForward,
  onSecretDrop,
}: PeerPaneViewProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [resourceGroups, setResourceGroups] = useState(pane.schema.resourceGroups);
  const [importYamlOpen, setImportYamlOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [nsFilter, setNsFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("ns");
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nsFilter) url.searchParams.set("ns", nsFilter);
    else url.searchParams.delete("ns");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [nsFilter]);

  useEffect(() => {
    setResourceGroups(pane.schema.resourceGroups);
  }, [pane]);

  const supportsSecretImport = !!pane.schema.supportsSecretImport && !!onSecretDrop;
  const droppableId = `secret-import:${accountId}:${parentResourceId}`;
  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const dragFromSameCluster = activeResource?.accountId === accountId;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: droppableId,
    disabled: dragFromSameCluster || !supportsSecretImport,
  });

  useDndMonitor({
    onDragEnd(event) {
      if (!supportsSecretImport) return;
      if (String(event.over?.id) !== droppableId) return;
      const resource = event.active.data.current?.resource as DraggableResource | undefined;
      if (!resource) return;
      if (resource.accountId === accountId) return;
      onSecretDrop?.(resource);
    },
  });

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

  const filteredGroups = useMemo(() => {
    if (!nsFilter) return resourceGroups;
    return resourceGroups.map((group) => {
      if (group.resourceTypeId === "k8s-namespace") {
        return {
          ...group,
          items: group.items.filter((item) => item.displayName === nsFilter),
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

  const visibleGroups = filteredGroups.filter((g) => g.items.length > 0 || g.supportsCreate);

  function toggleGroupCollapsed(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const isProvisioning =
    pane.schema.status?.status === "provisioning" && resourceGroups.length === 0;
  const paneError =
    pane.schema.status?.status === "error" && resourceGroups.length === 0
      ? pane.schema.status.label
        ? gtData(pane.schema.status.label)
        : gt("Failed to load workloads")
      : null;
  const guidance = pane.schema.guidance;
  // Guidance was originally a whole-pane replacement (the host's "this peer is
  // unreachable" state, which always comes with zero groups). A peer can also
  // use it to caveat data it *did* return — Kubernetes cost allocation
  // explaining that node prices are derived, or missing. In that case it has
  // to render as a banner above the groups; replacing them would hide the
  // workloads to explain a footnote about them.
  const guidanceIsBanner = !!guidance && resourceGroups.length > 0;

  const guidanceBlock = guidance ? (
    <div className={guidanceIsBanner ? "" : "py-12 px-6 max-w-2xl"}>
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-2 rounded-full bg-amber-400 flex-shrink-0 mt-1.5" />
          <p className="text-sm font-medium text-on-surface leading-relaxed">
            {gtData(guidance.title)}
          </p>
        </div>
        {guidance.suggestions.length > 0 && (
          <ul className="space-y-2 ml-5 list-disc text-sm text-on-surface-secondary marker:text-on-surface-muted">
            {guidance.suggestions.map((s, i) => (
              <li key={i} className="leading-relaxed">
                {gtData(s)}
              </li>
            ))}
          </ul>
        )}
        {guidance.action && (
          <button
            type="button"
            onClick={() =>
              dispatchPromptNoSqlCommand({
                command: guidance.action!.command,
                fields: guidance.action!.fields,
                ...(guidance.action!.title ? { title: guidance.action!.title } : {}),
                ...(guidance.action!.description
                  ? { description: guidance.action!.description }
                  : {}),
                ...(guidance.action!.submitLabel
                  ? { submitLabel: guidance.action!.submitLabel }
                  : {}),
                resourceId: parentResourceId,
              })
            }
            className="ml-5 px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-md hover:bg-accent-blue/90 transition-colors"
          >
            {gtData(guidance.action.label)}
          </button>
        )}
      </div>
    </div>
  ) : null;

  if (guidanceBlock && !guidanceIsBanner) return guidanceBlock;

  if (isProvisioning) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-y-4">
        <div
          aria-hidden="true"
          className="size-10 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin"
        />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-on-surface-secondary">
            {gt("Cluster is provisioning")}
          </p>
          <p className="text-xs text-on-surface-muted max-w-xs">
            {gt(
              "Workloads will appear here once the cluster is ready. This usually takes a few minutes.",
            )}
          </p>
        </div>
      </div>
    );
  }

  if (paneError) {
    return (
      <div className="py-16 px-6">
        <ErrorNotice message={paneError} />
      </div>
    );
  }

  return (
    <div
      ref={setDropRef}
      className={`space-y-3 transition-colors rounded-xl ${isOver && supportsSecretImport ? "ring-2 ring-blue-500/50 bg-accent-muted" : ""}`}
      data-parent-resource-id={parentResourceId}
    >
      {guidanceBlock}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {namespaces.length > 1 && (
            <select
              value={nsFilter ?? ""}
              onChange={(e) => setNsFilter(e.target.value || null)}
              aria-label={gt("Filter by namespace")}
              className="text-xs bg-surface-overlay border border-border-strong text-on-surface-secondary rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500 transition-colors"
            >
              <option value="">
                {gt("All namespaces ({count})", { count: namespaces.length })}
              </option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onImportYaml && (
            <button
              type="button"
              onClick={() => setImportYamlOpen(true)}
              className="px-3 py-1.5 rounded-lg border border-border-strong bg-surface-overlay hover:bg-surface-sunken text-sm text-on-surface-secondary transition-colors"
            >
              {gt("Import YAML")}
            </button>
          )}
          {k9s && (
            <button
              type="button"
              onClick={() => {
                if (!k9s.disabled) k9s.onOpen();
              }}
              disabled={k9s.disabled}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-surface-overlay disabled:text-on-surface-tertiary disabled:hover:bg-surface-overlay text-sm font-medium text-white transition-colors"
            >
              {gtData(k9s.label)}
            </button>
          )}
        </div>
      </div>

      {visibleGroups.length === 0 && (
        <div className="rounded-2xl border border-border bg-surface-raised/40 px-6 py-10 text-center">
          <p className="text-sm text-on-surface-secondary">
            {gt("Connected, nothing to show here yet.")}
          </p>
          <p className="text-xs text-on-surface-muted mt-1.5">
            {resourceGroups.length > 0
              ? gt("No {groupNames} found. Create one in the provider, then refresh.", {
                  groupNames: resourceGroups
                    .map((g) => gtData(g.title.replace(/\s*\(\d+\)\s*$/, "").toLowerCase()))
                    .join(" / "),
                })
              : gt("Create a resource in the provider, then refresh.")}
          </p>
        </div>
      )}

      {visibleGroups.map((group) => {
        const groupKey = `${group.pluginId}:${group.resourceTypeId}`;
        const isNamespaceGroup = group.resourceTypeId === "k8s-namespace";
        const isCollapsed = collapsedGroups.has(groupKey);
        const itemCount = group.items.length;

        if (isNamespaceGroup && nsFilter) return null;

        return (
          <section
            key={groupKey}
            className="rounded-2xl border border-border bg-surface-raised/40 overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-overlay/30 transition-colors">
              <button
                type="button"
                onClick={() => toggleGroupCollapsed(groupKey)}
                aria-expanded={!isCollapsed}
                aria-controls={`peer-pane-group-${groupKey}`}
                className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer select-none"
              >
                <span
                  aria-hidden="true"
                  className={`text-on-surface-muted text-xs transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                >
                  ▶
                </span>
                <h3 className="text-sm font-semibold text-on-surface">
                  {getGroupDisplayTitle(group.title, itemCount)}
                </h3>
                {isNamespaceGroup && (
                  <span className="text-xs text-on-surface-muted">
                    {gt("{count} user", {
                      count: group.items.filter(
                        (ns) =>
                          ns.fields["system"] !== "true" && namespaces.includes(ns.displayName),
                      ).length,
                    })}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-2">
                {group.supportsCreate && onCreate && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreate(group);
                    }}
                    className="px-2.5 py-1 rounded-lg border border-border-strong bg-surface-overlay text-xs text-on-surface-secondary hover:border-border-strong hover:bg-surface-sunken transition-colors"
                  >
                    {gt("Create {label}", { label: gtData(getCreateLabel(group.title)) })}
                  </button>
                )}
              </div>
            </div>

            {!isCollapsed && itemCount > 0 && (
              <div id={`peer-pane-group-${groupKey}`} className="px-4 pb-3">
                {isNamespaceGroup ? (
                  <NamespaceGrid
                    items={group.items.filter((ns) => namespaces.includes(ns.displayName))}
                    activeNamespace={nsFilter}
                    onSelect={(ns) => setNsFilter(nsFilter === ns ? null : ns)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {group.items.map((resource) => {
                      const isService = group.resourceTypeId === "k8s-service";
                      const hasSelector = resource.fields["hasSelector"] === "true";
                      const pfEntry = portForward?.entries.find(
                        (pf) =>
                          pf.resourceName === resource.displayName &&
                          pf.namespace ===
                            (resource.namespace ??
                              String(resource.fields["namespace"] ?? "default")),
                      );
                      return (
                        <PeerResourcePill
                          key={resource.id}
                          pane={pane}
                          group={group}
                          resource={resource}
                          accountId={accountId}
                          onClick={() => onOpenPill(resource, group)}
                          {...(portForward && isService && hasSelector
                            ? { onPortForward: () => portForward.onStart(resource) }
                            : {})}
                          isPortForwarding={portForward?.starting === resource.id}
                          {...(pfEntry ? { activePortForward: pfEntry } : {})}
                          {...(portForward ? { onStopPortForward: portForward.onStop } : {})}
                          {...(onExec && resource.supportsExec
                            ? { onExec: () => onExec(resource, group) }
                            : {})}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isCollapsed && itemCount === 0 && (
              <div id={`peer-pane-group-${groupKey}`} className="px-4 pb-3">
                <p className="text-sm text-on-surface-muted">{gt("No resources found.")}</p>
              </div>
            )}
          </section>
        );
      })}

      {portForward && portForward.entries.length > 0 && (
        <div className="space-y-1.5">
          {portForward.entries.map((pf) => (
            <div
              key={pf.sessionId}
              className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-2.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                <span className="text-sm text-on-surface-secondary font-medium truncate">
                  {pf.resourceName}
                </span>
                <span className="text-xs text-on-surface-muted">{pf.namespace}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(`localhost:${pf.localPort}`);
                  }}
                  className="text-xs font-mono text-success hover:text-success-strong transition-colors"
                  title={gt("Click to copy")}
                >
                  localhost:{pf.localPort} → {pf.remotePort}
                </button>
                <button
                  type="button"
                  onClick={() => portForward.onStop(pf.sessionId)}
                  className="px-2 py-0.5 rounded text-xs text-danger hover:text-danger-strong hover:bg-red-500/10 transition-colors"
                >
                  {gt("Stop")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {portForward?.error && (
        <ErrorNotice
          message={portForward.error}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
          textClassName="text-sm text-danger"
        />
      )}

      {isOver && supportsSecretImport && (
        <div className="rounded-xl border-2 border-dashed border-blue-500/40 bg-accent-muted px-4 py-6 text-center">
          <p className="text-sm font-medium text-accent-on-muted">
            {gt("Drop to create K8s Secret")}
          </p>
          <p className="text-xs text-accent/60 mt-1">
            {gt("Secret keys will be created from the resource's outputs")}
          </p>
        </div>
      )}

      {importYamlOpen && onImportYaml && (
        <ImportYamlModal onClose={() => setImportYamlOpen(false)} onSubmit={onImportYaml} />
      )}
    </div>
  );
}

function NamespaceGrid({
  items,
  activeNamespace,
  onSelect,
}: {
  items: PeerPaneResource[];
  activeNamespace: string | null;
  onSelect: (ns: string) => void;
}) {
  const gt = useGT();
  const userNs = items.filter((ns) => ns.fields["system"] !== "true");
  const systemNs = items.filter((ns) => ns.fields["system"] === "true");
  const [showSystem, setShowSystem] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {userNs.map((ns) => (
          <button
            key={ns.id}
            type="button"
            onClick={() => onSelect(ns.displayName)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              activeNamespace === ns.displayName
                ? "bg-blue-600 text-white"
                : "bg-surface-overlay text-on-surface-secondary hover:bg-surface-sunken hover:text-on-surface"
            }`}
          >
            {ns.displayName}
            {ns.status && (
              <span
                role="img"
                aria-label={gt("Status: {status}", { status: ns.status })}
                className={`ml-1.5 inline-block size-1.5 rounded-full ${statusDotClass(ns.status)}`}
              />
            )}
          </button>
        ))}
      </div>
      {systemNs.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSystem(!showSystem)}
            className="text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
          >
            {showSystem
              ? gt("Hide {count} system namespace{suffix}", {
                  count: systemNs.length,
                  suffix: systemNs.length === 1 ? "" : "s",
                })
              : gt("Show {count} system namespace{suffix}", {
                  count: systemNs.length,
                  suffix: systemNs.length === 1 ? "" : "s",
                })}
          </button>
          {showSystem && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {systemNs.map((ns) => (
                <button
                  key={ns.id}
                  type="button"
                  onClick={() => onSelect(ns.displayName)}
                  className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                    activeNamespace === ns.displayName
                      ? "bg-blue-600/60 text-accent-on-muted"
                      : "bg-surface-overlay/50 text-on-surface-muted hover:bg-surface-sunken/50 hover:text-on-surface-tertiary"
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

function PeerResourcePill({
  pane,
  group,
  resource,
  accountId,
  onClick,
  onPortForward,
  isPortForwarding,
  activePortForward,
  onStopPortForward,
  onExec,
}: {
  pane: PeerPaneData;
  group: PeerPaneResourceGroup;
  resource: PeerPaneResource;
  accountId: string;
  onClick?: () => void;
  onPortForward?: () => void;
  isPortForwarding?: boolean;
  activePortForward?: PeerPanePortForwardEntry;
  onStopPortForward?: (sessionId: string) => void;
  onExec?: () => void;
}): ReactNode {
  const gt = useGT();
  const draggableResource: DraggableResource = {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: group.resourceTypeId,
    accountId,
    displayName: resource.displayName,
    fields: resource.fields,
    ...(resource.externalId ? { externalId: resource.externalId } : {}),
  };

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: resource.id,
    data: {
      resource: draggableResource,
      dragLabel: resource.displayName,
    },
  });

  return (
    // The wrapper is non-interactive; the native button below carries the dnd
    // drag ref/listeners/attributes so the exec/port-forward buttons stay
    // siblings rather than focusable descendants of an interactive element.
    <div
      className={`group flex items-center gap-2 pr-3 rounded-full border bg-surface-raised ${onClick ? "cursor-pointer hover:bg-surface-sunken" : "cursor-grab"} active:cursor-grabbing transition-colors ${
        activePortForward
          ? "border-emerald-500/40"
          : isDragging
            ? "opacity-40 border-border-strong"
            : "border-border-strong hover:border-border-strong"
      }`}
    >
      <button
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        type="button"
        onClick={onClick}
        {...(onClick
          ? {
              onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onClick();
                }
              },
            }
          : {})}
        className={`flex items-center gap-2 min-w-0 pl-3 py-2 text-left ${onClick ? "cursor-pointer" : "cursor-grab"} active:cursor-grabbing`}
      >
        <span
          className="size-4 flex-shrink-0"
          dangerouslySetInnerHTML={{ __html: pane.pluginLogoSvg }}
          aria-hidden
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-on-surface truncate">
              {resource.displayName}
            </span>
            {resource.status && (
              <span
                role="img"
                aria-label={gt("Status: {status}", { status: resource.status })}
                className={`size-2 rounded-full flex-shrink-0 ${statusDotClass(resource.status)}`}
              />
            )}
          </div>
          {resource.subtitle && (
            <p className="text-xs text-on-surface-muted truncate">{resource.subtitle}</p>
          )}
          {activePortForward && (
            <p className="text-xs text-success font-mono truncate">
              :{activePortForward.localPort} → :{activePortForward.remotePort}
            </p>
          )}
        </div>
      </button>
      {onExec && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onExec();
          }}
          className="ml-1 h-6 px-2 rounded-full bg-surface-overlay hover:bg-surface-sunken text-xs text-on-surface-secondary transition-colors whitespace-nowrap"
          title={gt("Exec shell")}
          aria-label={gt("Exec shell into {name}", { name: resource.displayName })}
        >
          <span aria-hidden="true">⌨</span>
        </button>
      )}
      {onPortForward && !activePortForward && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onPortForward();
          }}
          disabled={isPortForwarding}
          className="ml-1 h-6 px-2 rounded-full bg-surface-overlay hover:bg-surface-sunken disabled:opacity-50 text-xs text-on-surface-secondary transition-colors whitespace-nowrap"
          title={gt("Port forward")}
        >
          {isPortForwarding ? "…" : "⇌"}
        </button>
      )}
      {activePortForward && onStopPortForward && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onStopPortForward(activePortForward.sessionId);
          }}
          className="ml-1 size-6 rounded-full bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800/50 text-xs text-danger transition-colors"
          title={gt("Stop port forward")}
        >
          ■
        </button>
      )}
    </div>
  );
}

function getGroupDisplayTitle(title: string, itemCount: number): string {
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

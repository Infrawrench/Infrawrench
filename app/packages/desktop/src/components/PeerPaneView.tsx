import { useEffect, useMemo, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
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
  const droppableId = supportsSecretImport ? `secret-import:${accountId}` : `peer-pane:${accountId}`;
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: droppableId });

  // Listen for secret-import drop events dispatched by the root DndContext handler
  useEffect(() => {
    if (!supportsSecretImport) return;
    function onSecretDrop(e: Event) {
      const detail = (e as CustomEvent).detail as { source: DraggableResource; targetAccountId: string } | undefined;
      if (detail?.targetAccountId === accountId) {
        setSecretExportSource(detail.source);
      }
    }
    window.addEventListener("iw:secret-export-drop", onSecretDrop);
    return () => window.removeEventListener("iw:secret-export-drop", onSecretDrop);
  }, [supportsSecretImport, accountId]);

  const kubeconfig = pane.credentials["kubeconfig"];
  const showK9sAction = !!pane.schema.supportsK9s;
  const canOpenK9s = showK9sAction && !!kubeconfig;
  const k9sLabel =
    k9sInstalled === null
      ? "Checking k9s…"
      : k9sInstalled
        ? "Open in k9s"
        : "k9s not installed";

  const createClientFactory = useMemo(
    () =>
      createTarget
        ? async () => {
            const loaded = await getPlugin(createTarget.pluginId);
            if (!loaded) throw new Error(`Plugin "${createTarget.pluginId}" not loaded`);
            return loaded.plugin.createClient(pane.credentials);
          }
        : undefined,
    [createTarget, pane.credentials],
  );

  return (
    <div
      ref={setDropRef}
      className={`space-y-5 transition-colors rounded-xl ${isOver && supportsSecretImport ? "ring-2 ring-blue-500/50 bg-blue-500/5" : ""}`}
      data-parent-resource-id={parentResourceId}
    >
      {/* Status dot only shown when there's no k9s action (avoids a lonely dot) */}
      {pane.schema.status && !showK9sAction && (
        <StatusDotNodeRenderer node={pane.schema.status} />
      )}

      {showK9sAction && (
        <div className="flex justify-end">
          <button
            onClick={() => {
              if (canOpenK9s) setK9sOpen(true);
            }}
            disabled={!canOpenK9s}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-400 disabled:hover:bg-gray-800 text-sm font-medium text-white transition-colors"
          >
            {k9sLabel}
          </button>
        </div>
      )}

      {createError && (
        <ErrorNotice
          message={createError}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
          textClassName="text-sm text-red-200"
        />
      )}

      {resourceGroups.map((group) => (
        <section
          key={`${group.pluginId}:${group.resourceTypeId}`}
          className="rounded-2xl border border-gray-800 bg-gray-900/40 p-4"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-sm font-semibold text-gray-100">{group.title}</h3>
            {group.supportsCreate && (
              <button
                onClick={() => setCreateTarget(group)}
                className="px-2.5 py-1 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-200 hover:border-gray-600 hover:bg-gray-700 transition-colors"
              >
                Create {getCreateLabel(group.title)}
              </button>
            )}
          </div>

          {group.items.length > 0 ? (
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
          ) : (
            <p className="text-sm text-gray-500">No resources found.</p>
          )}
        </section>
      ))}

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
          targetAccountId={accountId}
          onClose={() => setSecretExportSource(null)}
          onCreated={() => setSecretExportSource(null)}
        />
      )}

      {/* Drop hint overlay for secret import */}
      {isOver && supportsSecretImport && (
        <div className="rounded-xl border-2 border-dashed border-blue-500/40 bg-blue-500/5 px-4 py-6 text-center">
          <p className="text-sm font-medium text-blue-300">Drop to create K8s Secret</p>
          <p className="text-xs text-blue-400/60 mt-1">Secret keys will be created from the resource's outputs</p>
        </div>
      )}
    </div>
  );
}

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

function replaceTrailingCount(title: string, count: number): string {
  return /\(\d+\)$/.test(title)
    ? title.replace(/\(\d+\)$/, `(${count})`)
    : title;
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
      return "healthy";
    case "pending":
    case "creating":
    case "containercreating":
      return "provisioning";
    case "crashloopbackoff":
    case "terminating":
      return "degraded";
    case "failed":
    case "error":
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

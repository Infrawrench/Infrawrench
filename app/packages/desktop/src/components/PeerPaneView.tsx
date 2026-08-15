import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  PeerPaneResource,
  PeerPaneResourceGroup,
  ResourceInstance,
  ResourceTypeDefinition,
  ResourceStatus,
} from "@infrawrench/plugin-base";
import {
  useUIStore,
  type PeerPaneData,
  formatErrorMessage,
  PeerPaneView as SharedPeerPaneView,
  replacePeerPaneCount,
  type PeerPanePortForwardEntry,
} from "@infrawrench/ui";
import { navigateToWorkspaceTarget, resourceTabTarget } from "../lib/workspace-tabs";
import type { DraggableResource } from "../lib/pins";
import { invoke } from "../lib/invoke";
import { getPlugin } from "../plugins/loader";
import { CreateResourceModal } from "./CreateResourceModal";
import { ErrorNotice } from "./ErrorNotice";
import { K8sExecPanel } from "./K8sExecPanel";
import { K9sTerminal } from "./K9sTerminal";
import { SecretExportModal } from "./SecretExportModal";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { startPortForward, type PortForwardHandle } from "../lib/k8s-dispatch";
import { deleteCloudResource, importCloudYaml } from "../lib/cloud-api";

/** Shared empty override map; identity-stable so the derived fallback is cheap. */
const EMPTY_MAP: ReadonlyMap<string, PeerPaneResourceGroup> = new Map();

interface PeerPaneViewProps {
  pane: PeerPaneData;
  accountId: string;
  parentResourceId: string;
}

export function PeerPaneView({ pane, accountId, parentResourceId }: PeerPaneViewProps) {
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
  const [portForwards, setPortForwards] = useState<PeerPanePortForwardEntry[]>([]);
  const [pfStarting, setPfStarting] = useState<string | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [extraGroupStateRef, setExtraGroupState] = useState<{
    forPane: PeerPaneData;
    map: ReadonlyMap<string, PeerPaneResourceGroup>;
  }>(() => ({ forPane: pane, map: EMPTY_MAP }));

  // Local overrides only apply to the pane they were captured against. When the
  // incoming pane changes identity (e.g. background refresh) the derived map
  // falls back to empty, which auto-resets the overrides without an effect.
  const activeExtraGroupState =
    extraGroupStateRef.forPane === pane ? extraGroupStateRef.map : EMPTY_MAP;

  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();

  const pfHandlesRef = useRef<Map<string, PortForwardHandle> | null>(null);
  pfHandlesRef.current ??= new Map();
  const pfHandles = pfHandlesRef.current;

  useEffect(() => {
    return () => {
      for (const handle of pfHandles.values()) handle.stop();
      pfHandles.clear();
    };
  }, []);

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

  // When items are added/removed (create/ephemeral delete) we override the pane's
  // resourceGroups with the local mutated copy in extraGroupState for that group key.
  const effectivePane = useMemo<PeerPaneData>(() => {
    if (activeExtraGroupState.size === 0) return pane;
    return {
      ...pane,
      schema: {
        ...pane.schema,
        resourceGroups: pane.schema.resourceGroups.map((group) => {
          const key = `${group.pluginId}:${group.resourceTypeId}`;
          return activeExtraGroupState.get(key) ?? group;
        }),
      },
    };
  }, [pane, activeExtraGroupState]);

  const peerPluginId = pane.schema.resourceGroups[0]?.pluginId ?? "kubernetes";
  const kubeconfig = pane.credentials["kubeconfig"];

  const handleOpenPill = useCallback(
    (resource: PeerPaneResource, group: PeerPaneResourceGroup) => {
      void navigateToWorkspaceTarget(
        navigate,
        resourceTabTarget(
          accountId,
          resource.id,
          group.pluginId,
          group.resourceTypeId,
          parentResourceId,
        ),
        { label: resource.displayName },
      );
    },
    [accountId, parentResourceId, navigate],
  );

  const handleImportYaml = useCallback(
    async (yamlText: string): Promise<{ applied: number }> => {
      if (activeCloudOrgId) {
        return importCloudYaml(activeCloudOrgId, peerPluginId, {
          accountId,
          yaml: yamlText,
          parentResourceId,
        });
      }
      const loaded = await getPlugin(peerPluginId);
      if (!loaded) throw new Error(`Plugin "${peerPluginId}" not loaded`);
      const services = buildPluginHostServices(loaded.plugin.manifest, pane.credentials);
      const client = loaded.plugin.createClient(pane.credentials, services);
      if (!client.importYaml) throw new Error("Plugin does not support YAML import");
      return client.importYaml(accountId, yamlText);
    },
    [accountId, parentResourceId, activeCloudOrgId, peerPluginId, pane.credentials],
  );

  async function handleStartPortForward(resource: PeerPaneResource) {
    const namespace = resource.namespace ?? String(resource.fields["namespace"] ?? "default");
    const portsStr = String(resource.fields["ports"] ?? "");
    const firstPort = Number(portsStr.split("/")[0]);
    if (!firstPort || isNaN(firstPort)) {
      setPfError(`Cannot determine port for ${resource.displayName}`);
      return;
    }

    setPfStarting(resource.id);
    setPfError(null);
    try {
      const handle = activeCloudOrgId
        ? await startPortForward({
            mode: "cloud",
            orgId: activeCloudOrgId,
            accountId,
            resourceId: parentResourceId,
            peerPluginId,
            namespace,
            resourceType: "svc",
            resourceName: resource.displayName,
            remotePort: firstPort,
          })
        : await (async () => {
            if (!kubeconfig) throw new Error("kubeconfig missing");
            return startPortForward({
              mode: "local",
              kubeconfig,
              namespace,
              resourceType: "svc",
              resourceName: resource.displayName,
              remotePort: firstPort,
            });
          })();

      pfHandles.set(handle.sessionId, handle);
      setPortForwards((prev) => [
        ...prev,
        {
          sessionId: handle.sessionId,
          localPort: handle.localPort,
          remotePort: firstPort,
          resourceName: resource.displayName,
          namespace,
        },
      ]);
      handle.onExit(() => {
        setPortForwards((prev) => prev.filter((pf) => pf.sessionId !== handle.sessionId));
        pfHandles.delete(handle.sessionId);
      });
    } catch (err) {
      setPfError(formatErrorMessage(err));
    } finally {
      setPfStarting(null);
    }
  }

  function handleStopPortForward(sessionId: string) {
    pfHandles.get(sessionId)?.stop();
    pfHandles.delete(sessionId);
    setPortForwards((prev) => prev.filter((pf) => pf.sessionId !== sessionId));
  }

  function handleExec(resource: PeerPaneResource, group: PeerPaneResourceGroup) {
    setExecTarget({ resource, group });
  }

  function handleSecretDrop(source: DraggableResource) {
    setSecretExportSource(source);
  }

  const canOpenK9s = !!(pane.schema.supportsK9s && (kubeconfig || activeCloudOrgId));
  const k9sLabel =
    k9sInstalled === null ? "Checking k9s…" : k9sInstalled ? "Open in k9s" : "k9s not installed";

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

  return (
    <>
      <SharedPeerPaneView
        pane={effectivePane}
        accountId={accountId}
        parentResourceId={parentResourceId}
        onOpenPill={handleOpenPill}
        {...(pane.schema.supportsYamlImport ? { onImportYaml: handleImportYaml } : {})}
        {...(pane.schema.supportsK9s
          ? {
              k9s: {
                label: k9sLabel,
                disabled: !canOpenK9s || k9sInstalled !== true,
                onOpen: () => setK9sOpen(true),
              },
            }
          : {})}
        onCreate={(group) => setCreateTarget(group)}
        onExec={handleExec}
        portForward={{
          entries: portForwards,
          starting: pfStarting,
          error: pfError,
          onStart: handleStartPortForward,
          onStop: handleStopPortForward,
        }}
        {...(pane.schema.supportsSecretImport ? { onSecretDrop: handleSecretDrop } : {})}
      />

      {k9sOpen && (kubeconfig || activeCloudOrgId) && (
        <TerminalOverlay title="k9s" onClose={() => setK9sOpen(false)}>
          <K9sTerminal
            {...(activeCloudOrgId
              ? {
                  cloudContext: {
                    orgId: activeCloudOrgId,
                    accountId,
                    resourceId: parentResourceId,
                    peerPluginId,
                  },
                }
              : kubeconfig
                ? { kubeconfig }
                : {})}
          />
        </TerminalOverlay>
      )}

      {execTarget && (kubeconfig || activeCloudOrgId) && (
        <TerminalOverlay
          title={
            execTarget.ephemeral
              ? `Scratch: ${execTarget.resource.displayName}`
              : `Exec: ${execTarget.resource.displayName}`
          }
          onClose={() => {
            if (execTarget.ephemeral) {
              const resourceId = execTarget.resource.id;
              const groupTypeId = execTarget.group.resourceTypeId;
              const groupPluginId = execTarget.group.pluginId;
              if (activeCloudOrgId) {
                deleteCloudResource(
                  activeCloudOrgId,
                  groupPluginId,
                  execTarget.resource.resourceTypeId,
                  resourceId,
                  accountId,
                  parentResourceId,
                ).catch(() => {
                  /* silently ignore cleanup errors */
                });
              } else {
                void (async () => {
                  try {
                    const loaded = await getPlugin(groupPluginId);
                    if (!loaded) return;
                    const services = buildPluginHostServices(
                      loaded.plugin.manifest,
                      pane.credentials,
                    );
                    const client = loaded.plugin.createClient(pane.credentials, services);
                    await client.deleteResource?.(
                      execTarget.resource.resourceTypeId,
                      resourceId,
                      accountId,
                    );
                  } catch {
                    /* silently ignore cleanup errors */
                  }
                })();
              }
              setExtraGroupState((prev) => {
                const next = new Map(prev.forPane === pane ? prev.map : EMPTY_MAP);
                const key = `${groupPluginId}:${groupTypeId}`;
                const base =
                  next.get(key) ??
                  pane.schema.resourceGroups.find(
                    (g) => g.pluginId === groupPluginId && g.resourceTypeId === groupTypeId,
                  );
                if (base) {
                  next.set(key, {
                    ...base,
                    title: replacePeerPaneCount(base.title, Math.max(0, base.items.length - 1)),
                    items: base.items.filter((item) => item.id !== resourceId),
                  });
                }
                return { forPane: pane, map: next };
              });
            }
            setExecTarget(null);
          }}
        >
          <K8sExecPanel
            {...(activeCloudOrgId
              ? {
                  cloudContext: {
                    orgId: activeCloudOrgId,
                    accountId,
                    resourceId: parentResourceId,
                    peerPluginId: execTarget.group.pluginId,
                  },
                }
              : kubeconfig
                ? { kubeconfig }
                : {})}
            namespace={execTarget.resource.namespace ?? "default"}
            podName={execTarget.resource.displayName}
            {...(execTarget.resource.containerName
              ? { containerName: execTarget.resource.containerName }
              : {})}
          />
        </TerminalOverlay>
      )}

      {createError && (
        <ErrorNotice
          message={createError}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
          textClassName="text-sm text-danger"
        />
      )}

      {createTarget && createResourceType && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={createTarget.pluginId}
          resourceType={createResourceType}
          parentResourceId={parentResourceId}
          {...(createClientFactory ? { clientFactory: createClientFactory } : {})}
          onClose={() => setCreateTarget(null)}
          onCreated={(created) => {
            const peerResource = toPeerPaneResource(created);
            const isEphemeralPod =
              createTarget.resourceTypeId === "k8s-pod" && created.fields["ephemeral"] === "true";
            const key = `${createTarget.pluginId}:${createTarget.resourceTypeId}`;

            setExtraGroupState((prev) => {
              const next = new Map(prev.forPane === pane ? prev.map : EMPTY_MAP);
              const base =
                next.get(key) ??
                pane.schema.resourceGroups.find(
                  (g) =>
                    g.pluginId === createTarget.pluginId &&
                    g.resourceTypeId === createTarget.resourceTypeId,
                );
              if (base) {
                next.set(key, {
                  ...base,
                  title: replacePeerPaneCount(base.title, base.items.length + 1),
                  items: [peerResource, ...base.items],
                });
              }
              return { forPane: pane, map: next };
            });

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

      {secretExportSource && (
        <SecretExportModal
          source={secretExportSource}
          targetPluginId={peerPluginId}
          targetCredentials={pane.credentials}
          onClose={() => setSecretExportSource(null)}
          onCreated={() => setSecretExportSource(null)}
        />
      )}
    </>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Mouse-only click-away backdrop; keyboard users close via the × button. No Escape
          handler on purpose — Escape is meaningful input inside the terminal. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-on-surface">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            title={`Close ${title}`}
            className="text-on-surface-muted hover:text-on-surface-secondary text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </div>
  );
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

function mapPeerStatus(status: string): ResourceStatus {
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

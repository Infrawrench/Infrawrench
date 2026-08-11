import type { ResourceInstance } from "@infrawrench/plugin-base";
import { K8sExecPanel } from "../../components/K8sExecPanel";

interface K8sConsoleModalProps {
  resource: ResourceInstance;
  orgId: string;
  accountId: string;
  parentResourceId: string;
  onClose: () => void;
}

export function K8sConsoleModal({
  resource,
  orgId,
  accountId,
  parentResourceId,
  onClose,
}: K8sConsoleModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Mouse-only click-away backdrop; keyboard users close via the × button. No Escape
          handler on purpose — Escape is meaningful input inside the exec console. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-on-surface">Console: {resource.displayName}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close console for ${resource.displayName}`}
            title={`Close console for ${resource.displayName}`}
            className="text-on-surface-muted hover:text-on-surface-secondary text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <K8sExecPanel
            cloudContext={{
              orgId,
              accountId,
              resourceId: parentResourceId,
              peerPluginId: resource.pluginId,
            }}
            namespace={String(resource.fields["namespace"] ?? "default")}
            podName={resource.displayName}
            {...(typeof resource.fields["containerName"] === "string" &&
            resource.fields["containerName"]
              ? { containerName: String(resource.fields["containerName"]) }
              : {})}
          />
        </div>
      </div>
    </div>
  );
}

import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { RESTORE_ANNOTATION } from "./mappers.js";

/**
 * Ready-to-run `kubectl` commands for CoreWeave savings findings. Node Pools
 * are `NodePool` objects (`compute.coreweave.com`) inside each CKS cluster,
 * so the commands run against that cluster's kubeconfig context.
 *
 * Reference: https://docs.coreweave.com/docs/products/cks/nodes/manage
 */
export function coreweaveRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "node-pool") return [];
  const name = remediationField(resource, "name");
  if (!name) return [];
  const pool = `nodepool ${shellQuote(name)}`;
  const ctx = `--context "$KUBE_CONTEXT"`;
  const autoscaling = resource.fields["autoscaling"] === true;
  const target = Number(resource.fields["targetNodes"] ?? 0);
  const scaledToZero = remediationField(resource, "state") === "scaled-to-zero";

  // The autoscaler would scale a pool straight back up, so an autoscaled pool
  // is switched to a fixed size of zero rather than just scaled.
  const stop: RemediationCommand = autoscaling
    ? {
        tool: "kubectl",
        command: `kubectl ${ctx} patch ${pool} --type merge -p ${shellQuote(JSON.stringify({ spec: { autoscaling: false, minNodes: 0, targetNodes: 0 } }))}`,
        description:
          "Turn the autoscaler off and scale the pool to zero Nodes, which stops instance billing.",
        destructive: false,
        placeholders: [CONTEXT],
      }
    : {
        tool: "kubectl",
        command: `kubectl ${ctx} scale ${pool} --replicas 0`,
        description: "Scale the pool to zero Nodes, which stops instance billing.",
        destructive: false,
        placeholders: [CONTEXT],
      };

  return [stop, startCommand(resource, pool, ctx, scaledToZero || target <= 0)];
}

const CONTEXT: RemediationPlaceholder = {
  name: "KUBE_CONTEXT",
  description: "The kubectl context for this pool's CKS cluster",
};

function startCommand(
  resource: RemediationResource,
  pool: string,
  ctx: string,
  sizeUnknown: boolean,
): RemediationCommand {
  if (sizeUnknown) {
    // Already at zero: the size to go back to is only in the annotation
    // Infrawrench wrote when it scaled the pool down.
    const path = `{.metadata.annotations.${RESTORE_ANNOTATION.replace(/\./g, "\\.")}}`;
    return {
      tool: "kubectl",
      command: `kubectl ${ctx} get ${pool} -o jsonpath=${shellQuote(path)}`,
      description:
        "Show the size the pool had before it was scaled to zero, to scale it back with kubectl scale or patch.",
      destructive: false,
      placeholders: [CONTEXT],
    };
  }
  const target = Number(resource.fields["targetNodes"]);
  if (resource.fields["autoscaling"] === true) {
    const spec: Record<string, number | boolean> = { autoscaling: true, targetNodes: target };
    const min = Number(resource.fields["minNodes"]);
    const max = Number(resource.fields["maxNodes"]);
    if (Number.isFinite(min) && resource.fields["minNodes"] !== undefined) spec["minNodes"] = min;
    if (Number.isFinite(max) && resource.fields["maxNodes"] !== undefined) spec["maxNodes"] = max;
    return {
      tool: "kubectl",
      command: `kubectl ${ctx} patch ${pool} --type merge -p ${shellQuote(JSON.stringify({ spec }))}`,
      description: `Restore the pool to ${target} Nodes with the autoscaler back on.`,
      destructive: false,
      placeholders: [CONTEXT],
    };
  }
  return {
    tool: "kubectl",
    command: `kubectl ${ctx} scale ${pool} --replicas ${target}`,
    description: `Scale the pool back to ${target} Nodes.`,
    destructive: false,
    placeholders: [CONTEXT],
  };
}

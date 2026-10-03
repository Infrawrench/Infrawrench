/**
 * Resource actions: the ARM POST operations behind the detail-page buttons
 * and the sleep/wake schedules (`lifecycle` on the resource types).
 *
 * One table drives both sides. `invokeAzureAction` looks the action up and
 * POSTs to `<resource>/<path>`; `azureActionButtons` decides which buttons a
 * resource's current state warrants. Provider paths and api-versions come
 * from `AZURE_ARM_SPECS`, so an api-version bump lands on list, delete and
 * actions at once.
 */
import type { ActionNode, ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, AZURE_ARM_SPECS, type AzureHttpContext } from "./shared.js";

interface AzureAction {
  /** Path segment after the resource, e.g. `start` → `.../vm1/start`. */
  path: string;
  /** Request body. ARM accepts no body for most actions; some require `{}`. */
  body?: unknown;
  label: string;
  confirmMessage?: string;
  successMessage: string;
  variant?: "danger";
  /** Show the button only when the resource's state allows it. */
  showWhen?: (fields: Record<string, unknown>) => boolean;
}

const lower = (value: unknown) => String(value ?? "").toLowerCase();

/** `field` holds one of `values` (case-insensitive). */
const fieldIs =
  (field: string, ...values: string[]) =>
  (fields: Record<string, unknown>) =>
    values.includes(lower(fields[field]));

/** Start/stop/restart for types whose run-state lives in `field`. */
function startStopRestart(
  field: string,
  running: string[],
  stopped: string[],
  noun: string,
  stopConfirm: string,
): Record<string, AzureAction> {
  return {
    start: {
      path: "start",
      label: "Start",
      successMessage: "Start requested.",
      showWhen: fieldIs(field, ...stopped),
    },
    stop: {
      path: "stop",
      label: "Stop",
      confirmMessage: stopConfirm,
      successMessage: "Stop requested.",
      variant: "danger",
      showWhen: fieldIs(field, ...running),
    },
    restart: {
      path: "restart",
      label: "Restart",
      confirmMessage: `Restart this ${noun}? It is briefly unavailable while it restarts.`,
      successMessage: "Restart requested.",
      showWhen: fieldIs(field, ...running),
    },
  };
}

const WEB_APP_ACTIONS = startStopRestart(
  "state",
  ["running"],
  ["stopped"],
  "app",
  "Stop this app? It stops serving requests; the App Service plan it runs on keeps billing.",
);

const MYSQL_ACTIONS = startStopRestart(
  "state",
  ["ready"],
  ["stopped"],
  "server",
  "Stop this server? Compute billing stops (storage keeps billing). Azure starts a stopped server again automatically after 30 days.",
);
// MySQL's restart takes a required parameters body; Postgres' is optional.
MYSQL_ACTIONS["restart"] = {
  ...MYSQL_ACTIONS["restart"]!,
  body: { restartWithFailover: "Disabled" },
};

export const AZURE_ACTIONS: Record<string, Record<string, AzureAction>> = {
  "azure-vm": {
    // `deallocate` rather than `powerOff`: only deallocation releases the
    // compute, so it is the stop that actually halts VM billing.
    deallocate: {
      path: "deallocate",
      label: "Stop",
      confirmMessage:
        "Stop this VM? Deallocating releases the compute so VM billing stops; disks and public IPs keep billing.",
      successMessage: "Deallocate requested.",
      variant: "danger",
      showWhen: fieldIs("powerState", "vm running"),
    },
    start: {
      path: "start",
      label: "Start",
      successMessage: "Start requested.",
      showWhen: fieldIs("powerState", "vm deallocated", "vm stopped"),
    },
    restart: {
      path: "restart",
      label: "Restart",
      confirmMessage: "Restart this VM? The guest OS reboots and the VM is briefly unavailable.",
      successMessage: "Restart requested.",
      showWhen: fieldIs("powerState", "vm running"),
    },
  },
  "azure-aks-cluster": {
    start: {
      path: "start",
      label: "Start",
      successMessage: "Cluster start requested. Nodes take a few minutes to come back.",
      showWhen: fieldIs("powerState", "stopped"),
    },
    stop: {
      path: "stop",
      label: "Stop",
      confirmMessage:
        "Stop this cluster? AKS deallocates the control plane and every node pool, so workloads go down and compute billing stops. Cluster state is kept for up to 12 months.",
      successMessage: "Cluster stop requested.",
      variant: "danger",
      showWhen: fieldIs("powerState", "running"),
    },
  },
  "azure-app-service": WEB_APP_ACTIONS,
  "azure-function-app": WEB_APP_ACTIONS,
  // The container-group list carries no instance state, so every button shows.
  "azure-container-instance": {
    start: { path: "start", label: "Start", successMessage: "Start requested." },
    stop: {
      path: "stop",
      label: "Stop",
      confirmMessage:
        "Stop this container group? Its containers are terminated and compute billing stops.",
      successMessage: "Stop requested.",
      variant: "danger",
    },
    restart: {
      path: "restart",
      label: "Restart",
      confirmMessage: "Restart every container in this group in place?",
      successMessage: "Restart requested.",
    },
  },
  "azure-postgres-flexible": startStopRestart(
    "state",
    ["ready"],
    ["stopped"],
    "server",
    "Stop this server? Compute billing stops (storage keeps billing). Azure starts a stopped server again automatically after 7 days.",
  ),
  "azure-mysql-flexible": MYSQL_ACTIONS,
  "azure-app-gateway": {
    start: {
      path: "start",
      label: "Start",
      successMessage: "Start requested.",
      showWhen: fieldIs("operationalState", "stopped"),
    },
    stop: {
      path: "stop",
      label: "Stop",
      confirmMessage:
        "Stop this application gateway? It stops serving traffic and instance billing stops; its public IP keeps billing.",
      successMessage: "Stop requested.",
      variant: "danger",
      showWhen: fieldIs("operationalState", "running"),
    },
  },
  "azure-container-app": {
    start: {
      path: "start",
      label: "Start",
      successMessage: "Start requested.",
      showWhen: fieldIs("runningStatus", "stopped"),
    },
    stop: {
      path: "stop",
      label: "Stop",
      confirmMessage: "Stop this container app? It scales to zero and stops serving requests.",
      successMessage: "Stop requested.",
      variant: "danger",
      showWhen: fieldIs("runningStatus", "running"),
    },
  },
  "azure-container-app-job": {
    // Jobs/start with an empty body runs one execution of the job's own
    // template, the "Run now" of the portal.
    run: {
      path: "start",
      body: {},
      label: "Run now",
      confirmMessage: "Start an execution of this job now?",
      successMessage: "Job execution started.",
    },
  },
};

/** Header buttons for a resource, in table order, filtered by its state. */
export function azureActionButtons(resource: ResourceInstance): ActionNode[] {
  const actions = AZURE_ACTIONS[resource.resourceTypeId];
  if (!actions) return [];
  return Object.entries(actions)
    .filter(([, action]) => !action.showWhen || action.showWhen(resource.fields))
    .map(([actionId, action]) => ({
      kind: "action" as const,
      label: action.label,
      action: {
        type: "plugin-action" as const,
        actionId,
        ...(action.confirmMessage ? { confirmMessage: action.confirmMessage } : {}),
        successMessage: action.successMessage,
      },
      ...(action.variant ? { variant: action.variant } : {}),
    }));
}

/** Whether `invokeAzureAction` accepts this type/action pair. */
export function supportsAzureAction(typeId: string, actionId: string): boolean {
  return Boolean(AZURE_ACTIONS[typeId]?.[actionId]);
}

export async function invokeAzureAction(
  ctx: AzureHttpContext,
  resource: ResourceInstance,
  actionId: string,
): Promise<void> {
  const typeId = resource.resourceTypeId;
  const action = AZURE_ACTIONS[typeId]?.[actionId];
  const spec = AZURE_ARM_SPECS[typeId];
  if (!action || !spec?.provider) {
    throw new Error(`Azure plugin: invokeAction "${actionId}" not supported for type "${typeId}"`);
  }
  // externalId is rg/name: the same two-part form deleteResource splits.
  const [rg, name] = String(resource.externalId ?? "").split("/");
  if (!rg || !name) throw new Error(`Cannot determine resource group/name for ${typeId}`);
  await ctx.post(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${name}/${action.path}?api-version=${spec.apiVersion}`,
    action.body ?? {},
  );
}

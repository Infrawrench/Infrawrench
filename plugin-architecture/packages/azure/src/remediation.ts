/**
 * Ready-to-run Azure CLI commands for Azure savings findings.
 *
 * Every resource lister stores `name` and `resourceGroup` in the fields and
 * `<resourceGroup>/<name>` as externalId. The subscription is not on the row,
 * so resource commands reference `$AZURE_SUBSCRIPTION_ID`. Reservation and
 * savings plan commands are tenant-scoped and need no subscription.
 */
import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { AZURE_ARM_SPECS } from "./shared.js";

const AZURE_SUBSCRIPTION_PLACEHOLDER: RemediationPlaceholder = {
  name: "AZURE_SUBSCRIPTION_ID",
  description: "The Azure subscription ID this resource lives in",
};

const SUB = `--subscription "$AZURE_SUBSCRIPTION_ID"`;

interface Target {
  /** Shell-quoted `--resource-group X --name Y` pair. */
  args: string;
  name: string;
  resourceGroup: string;
}

function target(resource: RemediationResource): Target | null {
  const parts = (resource.externalId ?? "").split("/");
  const fromId = parts.length === 2 && parts.every(Boolean) ? parts : null;
  const resourceGroup = remediationField(resource, "resourceGroup") || fromId?.[0] || "";
  const name = remediationField(resource, "name") || fromId?.[1] || "";
  if (!resourceGroup || !name) return null;
  return {
    args: `--resource-group ${shellQuote(resourceGroup)} --name ${shellQuote(name)}`,
    name,
    resourceGroup,
  };
}

function az(command: string, description: string, destructive = false): RemediationCommand {
  return {
    tool: "az",
    command,
    description,
    destructive,
    placeholders: [AZURE_SUBSCRIPTION_PLACEHOLDER],
  };
}

/** Tenant-scoped commands (reservations, savings plans) reference no placeholder. */
function azTenant(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "az", command, description, destructive };
}

// https://learn.microsoft.com/en-us/cli/azure/vm#az-vm-list-vm-resize-options
// https://learn.microsoft.com/en-us/cli/azure/vm#az-vm-resize
function vmResize(resource: RemediationResource, targetSize: string): RemediationCommand[] {
  const t = target(resource);
  if (!t || !targetSize) return [];
  return [
    az(
      `az vm list-vm-resize-options ${t.args} ${SUB} --output table`,
      `Check that ${targetSize} is offered on the VM's current hardware cluster.`,
    ),
    az(
      `az vm resize ${t.args} --size ${shellQuote(targetSize)} ${SUB}`,
      `Resize the VM to ${targetSize} in place; Azure restarts it, which causes downtime.`,
    ),
  ];
}

/**
 * Stop/start pairs for each type declaring `lifecycle`, all verified against
 * the az reference:
 * https://learn.microsoft.com/en-us/cli/azure/vm#az-vm-deallocate
 * https://learn.microsoft.com/en-us/cli/azure/webapp#az-webapp-stop
 * https://learn.microsoft.com/en-us/cli/azure/functionapp#az-functionapp-stop
 * https://learn.microsoft.com/en-us/cli/azure/container#az-container-stop
 * https://learn.microsoft.com/en-us/cli/azure/aks#az-aks-stop
 * https://learn.microsoft.com/en-us/cli/azure/network/application-gateway#az-network-application-gateway-stop
 * https://learn.microsoft.com/en-us/cli/azure/mysql/flexible-server#az-mysql-flexible-server-stop
 * https://learn.microsoft.com/en-us/cli/azure/postgres/flexible-server#az-postgres-flexible-server-stop
 */
const SLEEP_COMMANDS: Record<string, { group: string; stop: string; stopNote: string }> = {
  "azure-vm": {
    group: "vm",
    stop: "deallocate",
    stopNote: "Deallocate the VM so compute billing stops; disks and public IPs keep billing.",
  },
  "azure-app-service": {
    group: "webapp",
    stop: "stop",
    stopNote: "Stop the web app; the App Service plan it runs on keeps billing.",
  },
  "azure-function-app": {
    group: "functionapp",
    stop: "stop",
    stopNote: "Stop the function app; a dedicated App Service plan keeps billing.",
  },
  "azure-container-instance": {
    group: "container",
    stop: "stop",
    stopNote: "Stop all containers in the group so its compute is deallocated and billing stops.",
  },
  "azure-aks-cluster": {
    group: "aks",
    stop: "stop",
    stopNote: "Stop the cluster's control plane and node pools so compute billing stops.",
  },
  "azure-app-gateway": {
    group: "network application-gateway",
    stop: "stop",
    stopNote: "Stop the application gateway so its instance billing stops.",
  },
  "azure-mysql-flexible": {
    group: "mysql flexible-server",
    stop: "stop",
    stopNote:
      "Stop the server so compute billing stops; storage keeps billing and Azure restarts it after 30 days.",
  },
  "azure-postgres-flexible": {
    group: "postgres flexible-server",
    stop: "stop",
    stopNote:
      "Stop the server so compute billing stops; storage keeps billing and Azure restarts it after 7 days.",
  },
};

/**
 * The az CLI has no `containerapp stop`/`start` (only for jobs and sessions),
 * so those go through `az rest` against the ARM actions:
 * https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/stop
 * https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/start
 * https://learn.microsoft.com/en-us/cli/azure/reference-index#az-rest
 */
function containerAppSleep(resource: RemediationResource): RemediationCommand[] {
  const t = target(resource);
  if (!t) return [];
  const spec = AZURE_ARM_SPECS["azure-container-app"];
  if (!spec) return [];
  const url = (action: string) =>
    `"https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/"` +
    `${shellQuote(encodeURIComponent(t.resourceGroup))}` +
    `"/providers/${spec.provider}/"${shellQuote(encodeURIComponent(t.name))}` +
    `"/${action}?api-version=${spec.apiVersion}"`;
  return [
    az(
      `az rest --method post --url ${url("stop")}`,
      "Stop the container app so its replicas scale to zero and stop billing.",
    ),
    az(`az rest --method post --url ${url("start")}`, "Start the container app again."),
  ];
}

function sleepCommands(resource: RemediationResource): RemediationCommand[] {
  if (resource.resourceTypeId === "azure-container-app") return containerAppSleep(resource);
  const spec = SLEEP_COMMANDS[resource.resourceTypeId];
  const t = target(resource);
  if (!spec || !t) return [];
  return [
    az(`az ${spec.group} ${spec.stop} ${t.args} ${SUB}`, spec.stopNote),
    az(`az ${spec.group} start ${t.args} ${SUB}`, "Start it again."),
  ];
}

// https://learn.microsoft.com/en-us/cli/azure/appservice/plan#az-appservice-plan-delete
function appServicePlanDelete(resource: RemediationResource): RemediationCommand[] {
  const t = target(resource);
  if (!t) return [];
  return [
    az(
      `az appservice plan delete ${t.args} ${SUB}`,
      "Delete the empty App Service plan so its reserved instances stop billing.",
      true,
    ),
  ];
}

/**
 * `/providers/microsoft.capacity/reservationorders/<order>/reservations/<id>`
 * or `/providers/microsoft.billingbenefits/savingsplanorders/<order>/savingsplans/<id>`
 * (commitment ids are lower-cased by the commitments mapper).
 */
function parseCommitmentId(
  id: string,
): { kind: "reservation" | "savings_plan"; order: string; child: string } | null {
  const m =
    /\/providers\/microsoft\.capacity\/reservationorders\/([^/]+)\/reservations\/([^/]+)$/i.exec(
      id,
    );
  if (m) return { kind: "reservation", order: m[1]!, child: m[2]! };
  const s =
    /\/providers\/microsoft\.billingbenefits\/savingsplanorders\/([^/]+)\/savingsplans\/([^/]+)$/i.exec(
      id,
    );
  if (s) return { kind: "savings_plan", order: s[1]!, child: s[2]! };
  return null;
}

const RETURN_PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "RETURN_QUANTITY", description: "How many of the reservation's instances to return" },
  {
    name: "REFUND_SESSION_ID",
    description: "The sessionId printed by the calculate-refund command",
  },
];

// https://learn.microsoft.com/en-us/cli/azure/reservations/reservation
// https://learn.microsoft.com/en-us/cli/azure/reservations/reservation-order#az-reservations-reservation-order-calculate-refund
// https://learn.microsoft.com/en-us/cli/azure/reservations/reservation-order#az-reservations-reservation-order-return
// https://learn.microsoft.com/en-us/cli/azure/reservations#az-reservations-calculate-exchange
function reservationCommands(
  order: string,
  child: string,
  fullId: string,
  scope: string | null,
): RemediationCommand[] {
  const ids = `--reservation-order-id ${shellQuote(order)} --reservation-id ${shellQuote(child)}`;
  const orderPath = `/providers/microsoft.capacity/reservationOrders/${order}`;
  const out: RemediationCommand[] = [
    azTenant(
      `az reservations reservation show ${ids}`,
      "Show the reservation's SKU, quantity, scope and utilization.",
    ),
  ];
  if (scope !== "Shared") {
    out.push(
      azTenant(
        `az reservations reservation update ${ids} --applied-scope-type Shared`,
        "Widen the scope to Shared so matching usage in every subscription of the billing account can use it.",
      ),
    );
  }
  out.push(
    azTenant(
      `az reservations reservation update ${ids} --renew false`,
      "Turn off auto-renewal so the reservation ends with its current term.",
    ),
    {
      tool: "az",
      command: `az reservations reservation-order calculate-refund --reservation-order-id ${shellQuote(order)} --id ${shellQuote(orderPath)} --scope Reservation --reservation-id ${shellQuote(fullId)} --quantity "$RETURN_QUANTITY"`,
      description:
        "Quote the refund for returning instances and print the sessionId the return needs; to swap for another SKU instead, use az reservations calculate-exchange.",
      destructive: false,
      placeholders: RETURN_PLACEHOLDERS,
    },
    {
      tool: "az",
      command: `az reservations reservation-order return --reservation-order-id ${shellQuote(order)} --scope Reservation --reservation-id ${shellQuote(fullId)} --quantity "$RETURN_QUANTITY" --session-id "$REFUND_SESSION_ID" --return-reason Underutilized`,
      description:
        "Return the instances for a prorated refund; the discount ends immediately and returns count against the yearly refund limit.",
      destructive: true,
      placeholders: RETURN_PLACEHOLDERS,
    },
  );
  return out;
}

// https://learn.microsoft.com/en-us/cli/azure/billing-benefits/savings-plan-order/savings-plan
// Savings plans cannot be cancelled, returned or exchanged; scope and renewal are all that change.
function savingsPlanCommands(
  order: string,
  child: string,
  scope: string | null,
): RemediationCommand[] {
  const ids = `--savings-plan-order-id ${shellQuote(order)} --savings-plan-id ${shellQuote(child)}`;
  const out: RemediationCommand[] = [
    azTenant(
      `az billing-benefits savings-plan-order savings-plan show ${ids}`,
      "Show the savings plan's commitment, scope and utilization; savings plans cannot be cancelled or refunded.",
    ),
  ];
  if (scope !== "Shared") {
    out.push(
      azTenant(
        `az billing-benefits savings-plan-order savings-plan update ${ids} --applied-scope-type Shared`,
        "Widen the scope to Shared so eligible usage across the billing account counts against it.",
      ),
    );
  }
  out.push(
    azTenant(
      `az billing-benefits savings-plan-order savings-plan update ${ids} --renew false`,
      "Turn off auto-renewal so the plan ends with its current term.",
    ),
  );
  return out;
}

function commitmentCommands(
  commitment: Extract<RemediationFinding, { kind: "idle-commitment" }>["commitment"],
): RemediationCommand[] {
  const fullId = commitment.id.trim();
  const parsed = parseCommitmentId(fullId);
  if (!parsed) return [];
  return parsed.kind === "reservation"
    ? reservationCommands(parsed.order, parsed.child, fullId, commitment.scope)
    : savingsPlanCommands(parsed.order, parsed.child, commitment.scope);
}

export function azureRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  switch (finding.kind) {
    case "oversized":
      return finding.resource.resourceTypeId === "azure-vm"
        ? vmResize(finding.resource, finding.targetSize)
        : [];
    case "sleep-schedule":
      return sleepCommands(finding.resource);
    case "orphan":
      return finding.resource.resourceTypeId === "azure-app-service-plan"
        ? appServicePlanDelete(finding.resource)
        : [];
    case "idle-commitment":
      return commitmentCommands(finding.commitment);
    default:
      return [];
  }
}

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { mapBounded, ReadBudget, readOptionalArmList, startingRow } from "../arm-list.js";
import { ARM, extractResourceGroup, type ListerContext, listAllPages } from "./shared.js";

/** Service Bus control-plane api-version the namespace list uses. */
const SERVICE_BUS_API_VERSION = "2024-01-01";

/**
 * The queue or topic closest to its maximum size. Queues and topics each report
 * `sizeInBytes` ("The size of the queue, in bytes") beside `maxSizeInMegabytes` ("The
 * maximum size of the queue in megabytes"); an entity at its maximum refuses sends.
 * Two requests per namespace (its queues and its topics); `undefined` when either
 * failed or could not be read whole, so a missing list never reads as "all empty".
 * https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/queues/list-by-namespace
 * https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/topics/list-by-namespace
 * (read 2026-11-23)
 */
async function readFullestEntity(
  reader: Pick<ListerContext, "get">,
  budget: ReadBudget,
  namespaceId: string,
): Promise<{ fullestEntity: string; fullestEntityPercent: number | string } | undefined> {
  const queues = await budget.hydrate(() =>
    readOptionalArmList(
      reader,
      `${ARM}${namespaceId}/queues?api-version=${SERVICE_BUS_API_VERSION}`,
    ),
  );
  if (!queues) return undefined;
  const topics = await budget.hydrate(() =>
    readOptionalArmList(
      reader,
      `${ARM}${namespaceId}/topics?api-version=${SERVICE_BUS_API_VERSION}`,
    ),
  );
  if (!topics) return undefined;
  let fullest: { name: string; percent: number } | undefined;
  for (const entity of [...queues, ...topics]) {
    const props = entity["properties"] as Record<string, unknown> | undefined;
    const size = props?.["sizeInBytes"];
    const maxMb = props?.["maxSizeInMegabytes"];
    if (typeof size !== "number" || typeof maxMb !== "number" || maxMb <= 0) continue;
    const percent = (size / (maxMb * 1024 * 1024)) * 100;
    if (!fullest || percent > fullest.percent) {
      fullest = { name: String(entity["name"] ?? ""), percent };
    }
  }
  // No entities: nothing can fill, so no reading rather than a 0.
  if (!fullest) return { fullestEntity: "", fullestEntityPercent: "" };
  return {
    fullestEntity: fullest.name,
    fullestEntityPercent: Math.round(fullest.percent * 100) / 100,
  };
}

export async function listServiceBusNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const budget = new ReadBudget();
  const reader = budget.reader(ctx);
  const items = await listAllPages(
    reader,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ServiceBus/namespaces?api-version=${SERVICE_BUS_API_VERSION}`,
  );
  return mapBounded(
    items,
    async (ns) => {
      const name = String(ns["name"] ?? "");
      const azureId = String(ns["id"] ?? "");
      const rg = extractResourceGroup(azureId);
      const props = ns["properties"] as Record<string, unknown> | undefined;
      const sku = ns["sku"] as Record<string, unknown> | undefined;
      const fullest = azureId ? await readFullestEntity(reader, budget, azureId) : undefined;

      return {
        id: ctx.id(accountId, "azure-service-bus", `${rg}/${name}`),
        pluginId: "azure",
        resourceTypeId: "azure-service-bus",
        accountId,
        displayName: name,
        fields: {
          name,
          resourceGroup: rg,
          location: String(ns["location"] ?? ""),
          sku: String(sku?.["name"] ?? ""),
          provisioningState: String(props?.["provisioningState"] ?? ""),
          status: String(props?.["status"] ?? ""),
          createdAt: String(props?.["createdAt"] ?? ""),
          ...fullest,
        },
        resolvedOutputs: {
          serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
        },
        secretStates: [],
        externalId: `${rg}/${name}`,
        createdAt: String(props?.["createdAt"] ?? ctx.now()),
        updatedAt: ctx.now(),
      };
    },
    { from: startingRow(items) },
  );
}

export async function listEventHubNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.EventHub/namespaces?api-version=2024-01-01`,
  );
  return items.map((ns) => {
    const name = String(ns["name"] ?? "");
    const azureId = String(ns["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = ns["properties"] as Record<string, unknown> | undefined;
    const sku = ns["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-event-hub", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-event-hub",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(ns["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        status: String(props?.["status"] ?? ""),
        isAutoInflateEnabled: (props?.["isAutoInflateEnabled"] as boolean) ?? false,
        maximumThroughputUnits: Number(props?.["maximumThroughputUnits"] ?? 0),
        // `sku.capacity` is "The Event Hubs throughput units for Basic or Standard
        // tiers" (premium units on Premium, which auto-inflate does not apply to), and
        // `maximumThroughputUnits` the "Upper limit of throughput units when
        // AutoInflate is enabled" (0 otherwise).
        // https://learn.microsoft.com/rest/api/eventhub/namespaces/list (read 2026-11-23)
        throughputUnits: /^(basic|standard)$/i.test(String(sku?.["tier"] ?? sku?.["name"] ?? ""))
          ? Number(sku?.["capacity"] ?? 0)
          : "",
      },
      resolvedOutputs: {
        serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

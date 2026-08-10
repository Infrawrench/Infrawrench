import type {
  PublishMessagePayload,
  PublishMessageResult,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { azureRequest, type AzureHttpTransport } from "./http.js";

interface PublishContext extends AzureHttpTransport {
  /** AAD token scoped to `https://servicebus.azure.net/.default`. */
  serviceBusToken: () => Promise<string>;
}

function extra(payload: PublishMessagePayload, key: string): string {
  const v = payload.extras[key];
  return typeof v === "string" ? v : "";
}

function extraRecord(payload: PublishMessagePayload, key: string): Record<string, string> {
  const v = payload.extras[key];
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}

function namespaceHost(resource: ResourceInstance): string {
  // The lister stores the FQDN as serviceBusEndpoint (e.g.
  // "https://my-ns.servicebus.windows.net:443/"). Fall back to the resource
  // name + the standard suffix when the endpoint isn't populated.
  const ep = String(resource.fields["serviceBusEndpoint"] ?? "");
  if (ep) {
    try {
      return new URL(ep).host;
    } catch {
      /* fall through to name-derived host */
    }
  }
  const name = String(resource.fields["name"] ?? resource.displayName);
  return `${name}.servicebus.windows.net`;
}

export async function publishServiceBus(
  ctx: PublishContext,
  resource: ResourceInstance,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const entity = extra(payload, "entity");
  if (!entity.trim()) throw new Error("Queue or topic name is required.");
  const properties = extraRecord(payload, "properties");

  const host = namespaceHost(resource);
  const tok = await ctx.serviceBusToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tok}`,
    "Content-Type": "application/json",
  };
  if (Object.keys(properties).length > 0) {
    const broker: Record<string, string> = {};
    for (const [k, v] of Object.entries(properties)) {
      if (k.trim()) broker[k] = v;
    }
    headers["BrokerProperties"] = JSON.stringify(broker);
  }

  const url = `https://${host}/${encodeURIComponent(entity)}/messages`;
  const res = await azureRequest(ctx.http, url, { method: "POST", headers, body: payload.body });
  if (!res.ok) {
    throw new Error(`Service Bus send ${res.status}: ${await res.text()}`);
  }
  return { summary: `Sent to ${entity}.` };
}

export async function publishEventHub(
  ctx: PublishContext,
  resource: ResourceInstance,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const hub = extra(payload, "hub");
  if (!hub.trim()) throw new Error("Event hub name is required.");
  const partitionKey = extra(payload, "partitionKey");

  const host = namespaceHost(resource);
  const tok = await ctx.serviceBusToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tok}`,
    "Content-Type": "application/atom+xml;type=entry;charset=utf-8",
  };
  if (partitionKey.trim()) {
    headers["BrokerProperties"] = JSON.stringify({ PartitionKey: partitionKey });
  }

  const url = `https://${host}/${encodeURIComponent(hub)}/messages`;
  const res = await azureRequest(ctx.http, url, { method: "POST", headers, body: payload.body });
  if (!res.ok) {
    throw new Error(`Event Hub send ${res.status}: ${await res.text()}`);
  }
  return { summary: `Event sent to ${hub}.` };
}

import type { FastlyContext } from "./api.js";
import { fastlyFetch, mapLimit, statusOf } from "./api.js";

/**
 * Per-service products, from the Enabled Products API
 * (`/enabled-products/v1/{product}/services[/{service_id}]`). The slugs are
 * the path segments in Fastly's published OpenAPI clients (2026-10).
 * `serviceTypes` limits a product to the service types Fastly offers it on.
 */
export const SERVICE_PRODUCTS: ReadonlyArray<{
  id: string;
  label: string;
  serviceTypes?: ReadonlyArray<"vcl" | "wasm">;
}> = [
  { id: "ngwaf", label: "Next-Gen WAF" },
  { id: "image_optimizer", label: "Image Optimizer" },
  { id: "bot_management", label: "Bot Management" },
  { id: "ddos_protection", label: "DDoS Protection" },
  { id: "brotli_compression", label: "Brotli Compression", serviceTypes: ["vcl"] },
  { id: "websockets", label: "WebSockets" },
  { id: "fanout", label: "Fanout" },
  { id: "origin_inspector", label: "Origin Inspector" },
  { id: "domain_inspector", label: "Domain Inspector" },
  { id: "log_explorer_insights", label: "Log Explorer & Insights" },
  { id: "api_discovery", label: "API Discovery" },
];

export function productLabel(id: string): string {
  return SERVICE_PRODUCTS.find((p) => p.id === id)?.label ?? id;
}

/**
 * Service id → enabled product ids, one request per product for the whole
 * account. A product the account has no entitlement for answers 4xx; it is
 * simply enabled nowhere.
 */
export async function enabledProductsByService(ctx: FastlyContext): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const lists = await mapLimit(SERVICE_PRODUCTS, 4, async (p) => {
    try {
      const res = await fastlyFetch<{ services?: string[] }>(
        ctx,
        `/enabled-products/v1/${p.id}/services`,
      );
      return { id: p.id, services: res?.services ?? [] };
    } catch (err) {
      const status = statusOf(err);
      if (status >= 400 && status < 500) return { id: p.id, services: [] as string[] };
      throw err;
    }
  });
  for (const { id, services } of lists) {
    for (const sid of services) {
      const list = out.get(sid) ?? [];
      list.push(id);
      out.set(sid, list);
    }
  }
  return out;
}

export async function setProductEnabled(
  ctx: FastlyContext,
  productId: string,
  serviceId: string,
  enabled: boolean,
): Promise<void> {
  if (!SERVICE_PRODUCTS.some((p) => p.id === productId)) {
    throw new Error(`Unknown Fastly product "${productId}".`);
  }
  await fastlyFetch<unknown>(
    ctx,
    `/enabled-products/v1/${productId}/services/${encodeURIComponent(serviceId)}`,
    { method: enabled ? "PUT" : "DELETE" },
  );
}

/**
 * The web edge Worker's plugin registry: every plugin's manifest and resource
 * types, with no plugin code behind them. See `plugin-loader.ts` for when this
 * replaces `plugin-registry.ts` and `plugin-registry-edge-format.ts` for the
 * file format. Calling any plugin function throws the gateway-only error, which
 * the edge router answers by handing the request to the Node gateway.
 */
import type { Plugin } from "@infrawrench/plugin-base";
import registry from "./plugin-registry-edge.gen.json";
import { FUNCTION_MARKER } from "./plugin-registry-edge-format";
import { GatewayOnlyError } from "./runtime/gateway-only";

function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const record = value as Record<string, unknown>;
  const marker = record[FUNCTION_MARKER];
  if (typeof marker === "string") {
    return () => {
      throw new GatewayOnlyError(`Plugin code (${marker})`);
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(record)) out[key] = decode(v);
  return out;
}

export const EDGE_PLUGINS: readonly Plugin[] = (registry.plugins as unknown[]).map(
  (p) => decode(p) as Plugin,
);

/**
 * Where a node's hourly price comes from.
 *
 * A Kubernetes cluster cannot know what it costs — the money is on the cloud
 * account that owns the VMs. The rate therefore has to arrive from outside,
 * and this module is the single place that decides how much to trust it.
 *
 * Two sources, in priority order:
 *
 *  1. **Real spend**, when the cloud plugin that owns the cluster can tell us
 *     what these particular nodes are actually being charged. This arrives
 *     through the existing peer-integration plumbing: each managed-Kubernetes
 *     resource type maps its `nodeHourlyRates` output onto the kubernetes
 *     plugin's `nodeHourlyRates` credential, exactly the way it already maps
 *     `kubeconfig`. The parent plugin builds that payload from whatever it
 *     knows best — node-pool prices from the provider API, its own pricing
 *     module, a billing export.
 *  2. **A published on-demand rate** for the node's instance type, marked as
 *     such so the UI can hedge the number.
 *
 * If neither is present we return `null` and every caller shows capacity and
 * efficiency without money. A fabricated price is worse than no price: it
 * gets believed.
 */

/** How much to trust a rate. Always surfaced, never silently dropped. */
export type RateSource = "billed" | "list-price" | "manual";

export interface NodeRateTable {
  currency: string;
  source: RateSource;
  /** instance type (e.g. `s-2vcpu-4gb`, `m5.large`) → hourly cost. */
  byInstanceType: Record<string, number>;
  /** Exact node name → hourly cost. Wins over `byInstanceType`. */
  byNodeName: Record<string, number>;
}

export const EMPTY_RATE_TABLE: NodeRateTable = {
  currency: "USD",
  source: "list-price",
  byInstanceType: {},
  byNodeName: {},
};

function coerceRateMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const num = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(num) && num >= 0) out[key] = num;
  }
  return out;
}

function coerceSource(value: unknown): RateSource {
  return value === "billed" || value === "manual" ? value : "list-price";
}

/**
 * Parse the `nodeHourlyRates` credential.
 *
 * Accepts the JSON form a parent cloud plugin emits:
 *
 *     {"currency":"USD","source":"billed",
 *      "byInstanceType":{"s-2vcpu-4gb":0.0357},
 *      "byNodeName":{"pool-abc-xyz":0.0357}}
 *
 * and a forgiving line/comma-separated form a human can type into the
 * optional credential field on a standalone Kubernetes account:
 *
 *     s-2vcpu-4gb=0.0357, m5.large=0.096
 *
 * Anything unparseable yields an empty table rather than an error — a
 * malformed rate hint must not stop the cluster from listing.
 */
export function parseNodeRates(raw: string | undefined | null): NodeRateTable {
  const text = (raw ?? "").trim();
  if (!text) return EMPTY_RATE_TABLE;

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const currency = typeof parsed["currency"] === "string" ? parsed["currency"] : "USD";
      return {
        currency: currency || "USD",
        source: coerceSource(parsed["source"]),
        byInstanceType: coerceRateMap(parsed["byInstanceType"]),
        byNodeName: coerceRateMap(parsed["byNodeName"]),
      };
    } catch {
      return EMPTY_RATE_TABLE;
    }
  }

  const byInstanceType: Record<string, number> = {};
  for (const entry of text.split(/[,\n]/)) {
    const [key, value] = entry.split("=");
    const name = (key ?? "").trim();
    const rate = Number((value ?? "").trim());
    if (name && Number.isFinite(rate) && rate >= 0) byInstanceType[name] = rate;
  }
  return { currency: "USD", source: "manual", byInstanceType, byNodeName: {} };
}

/** The hourly rate for a node, or `undefined` when we genuinely don't know. */
export function rateForNode(
  table: NodeRateTable,
  nodeName: string,
  instanceType: string,
): number | undefined {
  const exact = table.byNodeName[nodeName];
  if (exact !== undefined) return exact;
  if (!instanceType) return undefined;
  return table.byInstanceType[instanceType];
}

export function hasAnyRate(table: NodeRateTable): boolean {
  return Object.keys(table.byNodeName).length > 0 || Object.keys(table.byInstanceType).length > 0;
}

/** Human wording for where the money came from. Used in guidance and docs. */
export function describeRateSource(source: RateSource): string {
  switch (source) {
    case "billed":
      return "the cloud account that owns the nodes";
    case "manual":
      return "the rates you entered on this account";
    default:
      return "published on-demand list prices";
  }
}

/**
 * What the user should do when there is no rate at all. Kept here so the peer
 * pane, the docs and the cost declaration all say the same thing.
 */
export const NO_RATE_GUIDANCE = [
  "Open this cluster from its cloud account (DigitalOcean, GCP, AWS, Azure, Scaleway or OVHcloud) rather than from a standalone Kubernetes account — the cloud plugin passes its node prices through automatically.",
  "Or set the optional “Node hourly rates” field on this Kubernetes account to a list like `s-2vcpu-4gb=0.0357, m5.large=0.096`.",
  "Capacity, requests and efficiency are shown either way; only the money is missing.",
];

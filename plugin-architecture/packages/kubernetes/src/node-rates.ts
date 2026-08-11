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
  /**
   * The flat managed-control-plane fee, per cluster per hour.
   *
   * Every managed offering charges one and it is the same shape everywhere:
   * EKS is $0.10 per cluster per hour on standard support ($0.60 on extended),
   * GKE charges "a flat cluster management fee of $0.10 per cluster per hour …
   * irrespective of the mode of operation, cluster size, or topology", and
   * AKS's Standard tier is $0.10 per cluster per hour. It is a per-cluster
   * charge with no per-workload component whatsoever, which is exactly why it
   * gets its own bucket rather than a share of anyone's bill.
   *
   * Absent for a self-managed cluster — and it must stay absent there, because
   * a self-managed control plane runs on nodes that are already in
   * `/api/v1/nodes` and already priced as compute. Charging both would count
   * the same machines twice.
   */
  controlPlaneHourly?: number | undefined;
  /** Default price of one provisioned cloud load balancer, per hour. */
  loadBalancerHourly?: number | undefined;
  /**
   * `namespace/name` → hourly price for one specific Service. Wins over
   * `loadBalancerHourly`, including when it is `0` — which is how you tell
   * Infrawrench that a given `LoadBalancer` Service is served by an in-cluster
   * implementation (MetalLB, kube-vip) that costs nothing on the cloud bill.
   */
  loadBalancerByService: Record<string, number>;
  /**
   * StorageClass name → price per **provisioned** GiB-month. `*` is the
   * fallback for classes not named. Provisioned, not used: block storage bills
   * for what you asked for, and the cluster API cannot see how full a volume
   * is anyway.
   */
  storageGiBMonth: Record<string, number>;
}

export const EMPTY_RATE_TABLE: NodeRateTable = {
  currency: "USD",
  source: "list-price",
  byInstanceType: {},
  byNodeName: {},
  loadBalancerByService: {},
  storageGiBMonth: {},
};

/** The `*` key in {@link NodeRateTable.storageGiBMonth}: any storage class. */
export const ANY_STORAGE_CLASS = "*";

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

/** A single non-negative finite number, or `undefined` for anything else. */
function coerceRate(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

/**
 * Reserved keys in the human-typed form. An instance type is a provider SKU
 * (`s-2vcpu-4gb`, `m5.large`, `e2-standard-4`) and none of them collide with
 * these; `storage/…` cannot collide at all, since no instance type contains a
 * slash.
 */
const CONTROL_PLANE_KEY = "controlPlane";
const LOAD_BALANCER_KEY = "loadBalancer";
const STORAGE_PREFIX = "storage/";
const LOAD_BALANCER_PREFIX = "loadBalancer/";

/**
 * Parse the `nodeHourlyRates` credential.
 *
 * Accepts the JSON form a parent cloud plugin emits:
 *
 *     {"currency":"USD","source":"billed",
 *      "byInstanceType":{"s-2vcpu-4gb":0.0357},
 *      "byNodeName":{"pool-abc-xyz":0.0357}}
 *
 * plus the non-compute prices, which are the same idea one level up — a flat
 * control-plane fee, a per-load-balancer hourly price, and a per-GiB-month
 * price per storage class:
 *
 *     {"currency":"USD","source":"billed",
 *      "byInstanceType":{"s-2vcpu-4gb":0.0357},
 *      "controlPlaneHourly":0.10,
 *      "loadBalancerHourly":0.0149,
 *      "loadBalancerByService":{"kube-system/metallb-demo":0},
 *      "storageGiBMonth":{"*":0.10,"do-block-storage-xfs":0.10}}
 *
 * and a forgiving line/comma-separated form a human can type into the
 * optional credential field on a standalone Kubernetes account:
 *
 *     s-2vcpu-4gb=0.0357, m5.large=0.096
 *     controlPlane=0.10, loadBalancer=0.0149, storage/*=0.10
 *
 * Anything unparseable yields an empty table rather than an error — a
 * malformed rate hint must not stop the cluster from listing. Every new field
 * is optional in both forms: a parent cloud plugin that only knows node prices
 * keeps working unchanged, and the components it cannot price are reported as
 * capacity and counts with no money attached.
 */
export function parseNodeRates(raw: string | undefined | null): NodeRateTable {
  const text = (raw ?? "").trim();
  if (!text) return EMPTY_RATE_TABLE;

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const currency = typeof parsed["currency"] === "string" ? parsed["currency"] : "USD";
      const controlPlaneHourly = coerceRate(parsed["controlPlaneHourly"]);
      const loadBalancerHourly = coerceRate(parsed["loadBalancerHourly"]);
      return {
        currency: currency || "USD",
        source: coerceSource(parsed["source"]),
        byInstanceType: coerceRateMap(parsed["byInstanceType"]),
        byNodeName: coerceRateMap(parsed["byNodeName"]),
        ...(controlPlaneHourly !== undefined ? { controlPlaneHourly } : {}),
        ...(loadBalancerHourly !== undefined ? { loadBalancerHourly } : {}),
        loadBalancerByService: coerceRateMap(parsed["loadBalancerByService"]),
        storageGiBMonth: coerceRateMap(parsed["storageGiBMonth"]),
      };
    } catch {
      return EMPTY_RATE_TABLE;
    }
  }

  const byInstanceType: Record<string, number> = {};
  const loadBalancerByService: Record<string, number> = {};
  const storageGiBMonth: Record<string, number> = {};
  let controlPlaneHourly: number | undefined;
  let loadBalancerHourly: number | undefined;

  for (const entry of text.split(/[,\n]/)) {
    // `split("=")` on a value containing "=" would drop the tail; a rate never
    // contains one, but splitting on the first separator only is still the
    // correct reading of `key=value`.
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const name = entry.slice(0, eq).trim();
    const rate = coerceRate(entry.slice(eq + 1).trim());
    if (!name || rate === undefined) continue;

    if (name === CONTROL_PLANE_KEY) controlPlaneHourly = rate;
    else if (name === LOAD_BALANCER_KEY) loadBalancerHourly = rate;
    else if (name.startsWith(STORAGE_PREFIX)) {
      const cls = name.slice(STORAGE_PREFIX.length);
      if (cls) storageGiBMonth[cls] = rate;
    } else if (name.startsWith(LOAD_BALANCER_PREFIX)) {
      const service = name.slice(LOAD_BALANCER_PREFIX.length);
      if (service) loadBalancerByService[service] = rate;
    } else byInstanceType[name] = rate;
  }

  return {
    currency: "USD",
    source: "manual",
    byInstanceType,
    byNodeName: {},
    ...(controlPlaneHourly !== undefined ? { controlPlaneHourly } : {}),
    ...(loadBalancerHourly !== undefined ? { loadBalancerHourly } : {}),
    loadBalancerByService,
    storageGiBMonth,
  };
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

/**
 * The hourly price of one provisioned load balancer, or `undefined`.
 *
 * A per-Service entry wins over the flat rate *including when it is zero*, so
 * `loadBalancerByService` is also how an in-cluster implementation is excluded
 * from the money. `undefined` means "we do not know", which renders as a count
 * with no price; `0` means "we know, and it is free".
 */
export function loadBalancerRate(
  table: NodeRateTable,
  namespace: string,
  name: string,
): number | undefined {
  const exact = table.loadBalancerByService[`${namespace}/${name}`];
  if (exact !== undefined) return exact;
  return table.loadBalancerHourly;
}

/**
 * The price per provisioned GiB-month for a storage class. An exact class wins
 * over the `*` default. An empty class name (a PVC that names none, so the
 * cluster's default class applied) can only match `*` — guessing which class
 * the admission controller chose would be inventing.
 */
export function storageRate(table: NodeRateTable, storageClass: string): number | undefined {
  if (storageClass) {
    const exact = table.storageGiBMonth[storageClass];
    if (exact !== undefined) return exact;
  }
  return table.storageGiBMonth[ANY_STORAGE_CLASS];
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
  "The same field prices everything else a cluster costs: `controlPlane=0.10` for the managed-cluster fee, `loadBalancer=0.0149` per provisioned LoadBalancer Service, and `storage/*=0.10` per provisioned GiB-month (or `storage/gp3=0.08` for one class).",
  "Capacity, volume sizes, load-balancer counts, requests and efficiency are shown either way; only the money is missing.",
];

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";

export async function fetchMetricSeries(
  api: CloudflareApi,
  resourceTypeId: string,
  resourceId: string,
  _accountId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  if (resourceTypeId === "worker") {
    return fetchWorkerMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "r2-bucket") {
    return fetchR2MetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "spectrum-application") {
    return fetchSpectrumMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "d1-database") {
    return fetchD1MetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "kv-namespace") {
    return fetchKVMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "queue") {
    return fetchQueueMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "hyperdrive") {
    return fetchHyperdriveMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "load-balancer") {
    return fetchLoadBalancerMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "waiting-room") {
    return fetchWaitingRoomMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "durable-object-namespace") {
    return fetchDurableObjectMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "turnstile-widget") {
    return fetchTurnstileMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId === "ai-gateway") {
    return fetchAiGatewayMetricSeries(api, resourceId, timeRange);
  }
  if (resourceTypeId !== "zone") return [];

  const zoneId = resourceId.split(":").pop();
  if (!zoneId) return [];

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();

  // Pick aggregation granularity: hour buckets for windows ≥6h, minute for shorter.
  const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
  const useHourly = windowMs >= 6 * 3_600_000;
  const groupName = useHourly ? "httpRequests1hGroups" : "httpRequests1mGroups";
  const dimKey = useHourly ? "datetime" : "datetimeMinute";

  const query = `query Z($zone: String!, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          ${groupName}(
            limit: 1000
            filter: { datetime_geq: $from, datetime_lt: $to }
            orderBy: [${dimKey}_ASC]
          ) {
            dimensions { ${dimKey} }
            sum { requests bytes cachedRequests cachedBytes threats }
            uniq { uniques }
          }
        }
      }
    }`;

  interface GraphResp {
    data?: {
      viewer?: {
        zones?: Array<{
          httpRequests1mGroups?: GraphGroup[];
          httpRequests1hGroups?: GraphGroup[];
        }>;
      };
    };
  }
  interface GraphGroup {
    dimensions: { datetimeMinute?: string; datetime?: string };
    sum: {
      requests?: number;
      bytes?: number;
      cachedRequests?: number;
      cachedBytes?: number;
      threats?: number;
    };
    uniq: { uniques?: number };
  }

  let groups: GraphGroup[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { zone: zoneId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as GraphResp;
    const zoneGroups = json.data?.viewer?.zones?.[0];
    groups =
      (useHourly ? zoneGroups?.httpRequests1hGroups : zoneGroups?.httpRequests1mGroups) ?? [];
  } catch {
    return [];
  }

  if (groups.length === 0) return [];

  const tsOf = (g: GraphGroup): number =>
    new Date(String(g.dimensions[dimKey as "datetime"] ?? "")).getTime();

  const requests: MetricSeries = {
    label: "Requests",
    unit: "requests",
    points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.requests ?? 0) })),
  };
  const bytes: MetricSeries = {
    label: "Bandwidth",
    unit: "bytes",
    points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.bytes ?? 0) })),
  };
  const cached: MetricSeries = {
    label: "Cached Requests",
    unit: "requests",
    points: groups.map((g) => ({
      timestamp: tsOf(g),
      value: Number(g.sum.cachedRequests ?? 0),
    })),
  };
  const threats: MetricSeries = {
    label: "Threats",
    unit: "events",
    points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.threats ?? 0) })),
  };
  const uniques: MetricSeries = {
    label: "Unique Visitors",
    unit: "visitors",
    points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.uniq.uniques ?? 0) })),
  };

  return [requests, bytes, cached, threats, uniques].filter((s) =>
    s.points.some((p) => p.value > 0),
  );
}

/**
 * Worker metrics via GraphQL `workersInvocationsAdaptive`. Worker scripts
 * are account-scoped (not zone-scoped) so this resolves the CF account ID
 * via the shared client before issuing the query. Resource id encoding:
 * `${infrawrenchAccountId}:worker:${scriptName}` — we take the last segment.
 */
async function fetchWorkerMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const scriptName = resourceId.split(":").pop();
  if (!scriptName) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();
  const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
  // Workers GraphQL exposes 15-minute and 1-hour buckets; the 1m schema is
  // gated behind paid plans, so always pick 15m for short windows and 1h
  // for windows ≥6h.
  const useHourly = windowMs >= 6 * 3_600_000;
  const groupName = useHourly
    ? "workersInvocationsAdaptiveGroups"
    : "workersInvocationsAdaptiveGroups";
  const orderBy = "datetime_ASC";

  // workersInvocationsAdaptive sum-able fields are requests / subrequests /
  // errors only — duration is exposed via the `quantiles` block (cpuTimeP50/
  // cpuTimeP99, durationP50/durationP99). See:
  // https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
  const query = `query W($account: String!, $script: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          ${groupName}(
            limit: 1000
            filter: { scriptName: $script, datetime_geq: $from, datetime_lt: $to }
            orderBy: [${orderBy}]
          ) {
            dimensions { datetime }
            sum { requests subrequests errors }
            quantiles { cpuTimeP50 cpuTimeP99 }
          }
        }
      }
    }`;

  interface Group {
    dimensions: { datetime: string };
    sum: { requests?: number; subrequests?: number; errors?: number };
    quantiles: { cpuTimeP50?: number; cpuTimeP99?: number };
  }
  interface Resp {
    data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, script: scriptName, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const tsOf = (g: Group): number => new Date(g.dimensions.datetime).getTime();
  const series: MetricSeries[] = [
    {
      label: "Requests",
      unit: "requests",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.requests ?? 0) })),
    },
    {
      label: "Errors",
      unit: "errors",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.errors ?? 0) })),
    },
    {
      label: "Subrequests",
      unit: "subrequests",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.subrequests ?? 0) })),
    },
    {
      label: "CPU Time p50",
      unit: "μs",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.quantiles.cpuTimeP50 ?? 0),
      })),
    },
    {
      label: "CPU Time p99",
      unit: "μs",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.quantiles.cpuTimeP99 ?? 0),
      })),
    },
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * R2 bucket metrics via GraphQL `r2OperationsAdaptiveGroups` (Class A/B
 * operation counts) and `r2StorageAdaptiveGroups` (object/byte counts).
 * Both are account-scoped and filter by `bucketName`.
 */
async function fetchR2MetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const bucketName = resourceId.split(":").pop();
  if (!bucketName) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();

  const query = `query R($account: String!, $bucket: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          r2OperationsAdaptiveGroups(
            limit: 1000
            filter: { bucketName: $bucket, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime actionType }
            sum { requests responseObjectSize }
          }
          r2StorageAdaptiveGroups(
            limit: 1000
            filter: { bucketName: $bucket, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            max { metadataSize payloadSize objectCount uploadCount }
          }
        }
      }
    }`;

  interface OpsGroup {
    dimensions: { datetime: string; actionType: string };
    sum: { requests?: number; responseObjectSize?: number };
  }
  interface StorageGroup {
    dimensions: { datetime: string };
    max: {
      metadataSize?: number;
      payloadSize?: number;
      objectCount?: number;
      uploadCount?: number;
    };
  }
  interface Resp {
    data?: {
      viewer?: {
        accounts?: Array<{
          r2OperationsAdaptiveGroups?: OpsGroup[];
          r2StorageAdaptiveGroups?: StorageGroup[];
        }>;
      };
    };
  }

  let ops: OpsGroup[] = [];
  let storage: StorageGroup[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, bucket: bucketName, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    const acc = json.data?.viewer?.accounts?.[0];
    ops = acc?.r2OperationsAdaptiveGroups ?? [];
    storage = acc?.r2StorageAdaptiveGroups ?? [];
  } catch {
    return [];
  }

  // R2 splits requests into Class A (writes/lists, $$$) and Class B (reads, $).
  // Bucket the ops counts so the user sees both lines clearly.
  const tsOf = (s: { dimensions: { datetime: string } }): number =>
    new Date(s.dimensions.datetime).getTime();
  const classA = new Map<number, number>();
  const classB = new Map<number, number>();
  const CLASS_A_ACTIONS = new Set([
    "ListBuckets",
    "PutBucket",
    "ListObjects",
    "PutObject",
    "CopyObject",
    "CompleteMultipartUpload",
    "CreateMultipartUpload",
    "UploadPart",
    "UploadPartCopy",
    "PutBucketEncryption",
    "ListMultipartUploads",
    "PutBucketCors",
    "PutBucketLifecycleConfiguration",
  ]);
  for (const g of ops) {
    const t = tsOf(g);
    const v = Number(g.sum.requests ?? 0);
    const target = CLASS_A_ACTIONS.has(g.dimensions.actionType) ? classA : classB;
    target.set(t, (target.get(t) ?? 0) + v);
  }

  const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
    label,
    unit,
    points: [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value })),
  });

  const series: MetricSeries[] = [
    toSeries(classA, "Class A Operations", "requests"),
    toSeries(classB, "Class B Operations", "requests"),
  ];

  if (storage.length > 0) {
    series.push({
      label: "Object Count",
      unit: "objects",
      points: storage.map((g) => ({ timestamp: tsOf(g), value: Number(g.max.objectCount ?? 0) })),
    });
    series.push({
      label: "Stored Bytes",
      unit: "bytes",
      points: storage.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.max.payloadSize ?? 0) + Number(g.max.metadataSize ?? 0),
      })),
    });
  }

  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Durable Object namespace metrics via GraphQL
 * `durableObjectsInvocationsAdaptiveGroups` (account-scoped, filter by
 * `namespaceId`). Resource id:
 * `${infrawrenchAccountId}:durable-object-namespace:${namespaceId}`.
 */
async function fetchDurableObjectMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const namespaceId = resourceId.split(":").pop();
  if (!namespaceId) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();

  // Pull from three DO datasets in one query: invocations (requests +
  // response bytes), periodic (CPU time), and storage (stored bytes — the
  // actual on-disk size, the headline number the dashboard shows). Field
  // names below are the ones Cloudflare documents explicitly; other fields
  // (errors, wallTime, websocket counts) exist but need schema introspection
  // to confirm exact spelling, so they're left out to keep the query valid.
  const query = `query D($account: String!, $ns: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          durableObjectsInvocationsAdaptiveGroups(
            limit: 1000
            filter: { namespaceId: $ns, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            sum { requests responseBodySize }
          }
          durableObjectsPeriodicGroups(
            limit: 1000
            filter: { namespaceId: $ns, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            sum { cpuTime }
          }
          durableObjectsStorageGroups(
            limit: 1000
            filter: { namespaceId: $ns, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            max { storedBytes }
          }
        }
      }
    }`;

  interface InvGroup {
    dimensions: { datetime: string };
    sum: { requests?: number; responseBodySize?: number };
  }
  interface PeriodicGroup {
    dimensions: { datetime: string };
    sum: { cpuTime?: number };
  }
  interface StorageGroup {
    dimensions: { datetime: string };
    max: { storedBytes?: number };
  }
  interface Resp {
    data?: {
      viewer?: {
        accounts?: Array<{
          durableObjectsInvocationsAdaptiveGroups?: InvGroup[];
          durableObjectsPeriodicGroups?: PeriodicGroup[];
          durableObjectsStorageGroups?: StorageGroup[];
        }>;
      };
    };
  }

  let inv: InvGroup[] = [];
  let periodic: PeriodicGroup[] = [];
  let storage: StorageGroup[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, ns: namespaceId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    const acc = json.data?.viewer?.accounts?.[0];
    inv = acc?.durableObjectsInvocationsAdaptiveGroups ?? [];
    periodic = acc?.durableObjectsPeriodicGroups ?? [];
    storage = acc?.durableObjectsStorageGroups ?? [];
  } catch {
    return [];
  }

  const tsOf = (g: { dimensions: { datetime: string } }): number =>
    new Date(g.dimensions.datetime).getTime();
  const series: MetricSeries[] = [
    {
      label: "Requests",
      unit: "requests",
      points: inv.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.requests ?? 0) })),
    },
    {
      label: "Response Body Size",
      unit: "bytes",
      points: inv.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.sum.responseBodySize ?? 0),
      })),
    },
    {
      label: "CPU Time",
      unit: "μs",
      points: periodic.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.cpuTime ?? 0) })),
    },
    {
      label: "Stored Bytes",
      unit: "bytes",
      points: storage.map((g) => ({ timestamp: tsOf(g), value: Number(g.max.storedBytes ?? 0) })),
    },
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Turnstile widget metrics via GraphQL `turnstileAdaptiveGroups` (account-
 * scoped, filter by `siteKey`). Returns the challenge volume in fifteen-minute
 * buckets. Resource id:
 * `${infrawrenchAccountId}:turnstile-widget:${siteKey}`.
 */
async function fetchTurnstileMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const siteKey = resourceId.split(":").pop();
  if (!siteKey) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();

  const query = `query T($account: String!, $site: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          turnstileAdaptiveGroups(
            limit: 1000
            filter: { siteKey: $site, datetimeFifteenMinutes_geq: $from, datetimeFifteenMinutes_lt: $to }
            orderBy: [datetimeFifteenMinutes_ASC]
          ) {
            count
            dimensions { datetimeFifteenMinutes }
          }
        }
      }
    }`;

  interface Group {
    count?: number;
    dimensions: { datetimeFifteenMinutes: string };
  }
  interface Resp {
    data?: { viewer?: { accounts?: Array<{ turnstileAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, site: siteKey, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.accounts?.[0]?.turnstileAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const series: MetricSeries[] = [
    {
      label: "Challenges",
      unit: "challenges",
      points: groups.map((g) => ({
        timestamp: new Date(g.dimensions.datetimeFifteenMinutes).getTime(),
        value: Number(g.count ?? 0),
      })),
    },
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Spectrum application metrics via GraphQL
 * `spectrumNetworkAnalyticsAdaptiveGroups` (zone-scoped, filter by `appID`).
 * Resource id: `${infrawrenchAccountId}:spectrum-application:${zoneId}/${appId}`.
 */
async function fetchSpectrumMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  // Last colon-segment is "${zoneId}/${appId}"
  const lastSegment = resourceId.split(":").pop();
  if (!lastSegment) return [];
  const slashIdx = lastSegment.indexOf("/");
  if (slashIdx === -1) return [];
  const zoneId = lastSegment.slice(0, slashIdx);
  const appId = lastSegment.slice(slashIdx + 1);
  if (!zoneId || !appId) return [];

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();

  const query = `query S($zone: String!, $app: String!, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          spectrumNetworkAnalyticsAdaptiveGroups(
            limit: 1000
            filter: { appID: $app, datetime_geq: $from, datetime_lt: $to }
            orderBy: [datetime_ASC]
          ) {
            dimensions { datetime }
            sum { events bytesIngress bytesEgress connections }
          }
        }
      }
    }`;

  interface Group {
    dimensions: { datetime: string };
    sum: { events?: number; bytesIngress?: number; bytesEgress?: number; connections?: number };
  }
  interface Resp {
    data?: {
      viewer?: { zones?: Array<{ spectrumNetworkAnalyticsAdaptiveGroups?: Group[] }> };
    };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { zone: zoneId, app: appId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.zones?.[0]?.spectrumNetworkAnalyticsAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const tsOf = (g: Group): number => new Date(g.dimensions.datetime).getTime();
  const series: MetricSeries[] = [
    {
      label: "Events",
      unit: "events",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.events ?? 0) })),
    },
    {
      label: "Bytes Ingress",
      unit: "bytes",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.sum.bytesIngress ?? 0),
      })),
    },
    {
      label: "Bytes Egress",
      unit: "bytes",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.sum.bytesEgress ?? 0),
      })),
    },
    {
      label: "Connections",
      unit: "connections",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.sum.connections ?? 0),
      })),
    },
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * D1 database metrics via GraphQL `d1AnalyticsAdaptiveGroups`. Account-scoped,
 * filter by `databaseId`. Note that D1 analytics is daily-bucketed only — the
 * `date` dimension is the finest granularity, so even short windows roll up
 * to per-day points. Resource id: `${accountId}:d1-database:${uuid}` — the
 * trailing segment is the CF databaseId.
 */
async function fetchD1MetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const databaseId = resourceId.split(":").pop();
  if (!databaseId) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  // D1 uses `date_geq` / `date_leq` with `Date` type (yyyy-mm-dd).
  const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const start = toDate(timeRange?.startMs ?? now - 7 * 24 * 3_600_000);
  const end = toDate(timeRange?.endMs ?? now);

  const query = `query D($account: String!, $db: string, $start: Date, $end: Date) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          d1AnalyticsAdaptiveGroups(
            limit: 10000
            filter: { databaseId: $db, date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes }
            quantiles { queryBatchTimeMsP90 }
          }
        }
      }
    }`;

  interface Group {
    dimensions: { date: string };
    sum: {
      readQueries?: number;
      writeQueries?: number;
      rowsRead?: number;
      rowsWritten?: number;
      queryBatchResponseBytes?: number;
    };
    quantiles: { queryBatchTimeMsP90?: number };
  }
  interface Resp {
    data?: { viewer?: { accounts?: Array<{ d1AnalyticsAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, db: databaseId, start, end },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const tsOf = (g: Group): number => new Date(`${g.dimensions.date}T00:00:00Z`).getTime();
  const series: MetricSeries[] = [
    {
      label: "Read Queries",
      unit: "queries",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.readQueries ?? 0) })),
    },
    {
      label: "Write Queries",
      unit: "queries",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.writeQueries ?? 0) })),
    },
    {
      label: "Rows Read",
      unit: "rows",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.rowsRead ?? 0) })),
    },
    {
      label: "Rows Written",
      unit: "rows",
      points: groups.map((g) => ({ timestamp: tsOf(g), value: Number(g.sum.rowsWritten ?? 0) })),
    },
    {
      label: "Response Bytes",
      unit: "bytes",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.sum.queryBatchResponseBytes ?? 0),
      })),
    },
    {
      label: "Query Batch Time p90",
      unit: "ms",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.quantiles.queryBatchTimeMsP90 ?? 0),
      })),
    },
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * KV namespace metrics via GraphQL `kvOperationsAdaptiveGroups` (operation
 * counts per action type) and `kvStorageAdaptiveGroups` (key/byte counts).
 * Account-scoped, filter by `namespaceId`. Daily granularity only.
 * Resource id: `${accountId}:kv-namespace:${namespaceId}`.
 */
async function fetchKVMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const namespaceId = resourceId.split(":").pop();
  if (!namespaceId) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const start = toDate(timeRange?.startMs ?? now - 7 * 24 * 3_600_000);
  const end = toDate(timeRange?.endMs ?? now);

  const query = `query K($account: String!, $ns: string, $start: Date, $end: Date) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          kvOperationsAdaptiveGroups(
            limit: 10000
            filter: { namespaceId: $ns, date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date actionType }
            sum { requests }
          }
          kvStorageAdaptiveGroups(
            limit: 10000
            filter: { namespaceId: $ns, date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            max { keyCount byteCount }
          }
        }
      }
    }`;

  interface OpsGroup {
    dimensions: { date: string; actionType: string };
    sum: { requests?: number };
  }
  interface StorageGroup {
    dimensions: { date: string };
    max: { keyCount?: number; byteCount?: number };
  }
  interface Resp {
    data?: {
      viewer?: {
        accounts?: Array<{
          kvOperationsAdaptiveGroups?: OpsGroup[];
          kvStorageAdaptiveGroups?: StorageGroup[];
        }>;
      };
    };
  }

  let ops: OpsGroup[] = [];
  let storage: StorageGroup[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, ns: namespaceId, start, end },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    const acc = json.data?.viewer?.accounts?.[0];
    ops = acc?.kvOperationsAdaptiveGroups ?? [];
    storage = acc?.kvStorageAdaptiveGroups ?? [];
  } catch {
    return [];
  }

  // Bucket operations by actionType (read/write/delete/list) per day.
  const tsOfDate = (s: { dimensions: { date: string } }): number =>
    new Date(`${s.dimensions.date}T00:00:00Z`).getTime();
  const byAction = new Map<string, Map<number, number>>();
  for (const g of ops) {
    const a = g.dimensions.actionType || "unknown";
    const ts = tsOfDate(g);
    const v = Number(g.sum.requests ?? 0);
    let m = byAction.get(a);
    if (!m) {
      m = new Map();
      byAction.set(a, m);
    }
    m.set(ts, (m.get(ts) ?? 0) + v);
  }

  // Friendly labels keyed by the action types KV emits.
  const ACTION_LABELS: Record<string, string> = {
    read: "Reads",
    write: "Writes",
    delete: "Deletes",
    list: "Lists",
  };

  const series: MetricSeries[] = [];
  for (const [action, m] of byAction) {
    series.push({
      label: ACTION_LABELS[action] ?? `Operations (${action})`,
      unit: "requests",
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });
  }

  if (storage.length > 0) {
    series.push({
      label: "Key Count",
      unit: "keys",
      points: storage.map((g) => ({
        timestamp: tsOfDate(g),
        value: Number(g.max.keyCount ?? 0),
      })),
    });
    series.push({
      label: "Stored Bytes",
      unit: "bytes",
      points: storage.map((g) => ({
        timestamp: tsOfDate(g),
        value: Number(g.max.byteCount ?? 0),
      })),
    });
  }

  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Queue metrics via GraphQL `queueMessageOperationsAdaptiveGroups` (publish/
 * consume counts and bytes) and `queuesBacklogAdaptiveGroups` (backlog
 * messages/bytes). Account-scoped, filter by `queueId`. Resource id:
 * `${accountId}:queue:${queueId}`.
 */
async function fetchQueueMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const queueId = resourceId.split(":").pop();
  if (!queueId) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();
  const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
  const useHourly = windowMs >= 6 * 3_600_000;
  const timeDim = useHourly ? "datetimeHour" : "datetimeMinute";

  const query = `query Q($account: String!, $queue: string, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          queueMessageOperationsAdaptiveGroups(
            limit: 10000
            filter: { queueId: $queue, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            count
            sum { bytes }
            dimensions { ${timeDim} actionType }
          }
          queuesBacklogAdaptiveGroups(
            limit: 10000
            filter: { queueId: $queue, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            avg { messages bytes }
            dimensions { ${timeDim} }
          }
        }
      }
    }`;

  interface OpsGroup {
    count?: number;
    sum: { bytes?: number };
    dimensions: { datetimeMinute?: string; datetimeHour?: string; actionType: string };
  }
  interface BacklogGroup {
    avg: { messages?: number; bytes?: number };
    dimensions: { datetimeMinute?: string; datetimeHour?: string };
  }
  interface Resp {
    data?: {
      viewer?: {
        accounts?: Array<{
          queueMessageOperationsAdaptiveGroups?: OpsGroup[];
          queuesBacklogAdaptiveGroups?: BacklogGroup[];
        }>;
      };
    };
  }

  let ops: OpsGroup[] = [];
  let backlog: BacklogGroup[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, queue: queueId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    const acc = json.data?.viewer?.accounts?.[0];
    ops = acc?.queueMessageOperationsAdaptiveGroups ?? [];
    backlog = acc?.queuesBacklogAdaptiveGroups ?? [];
  } catch {
    return [];
  }

  const tsOf = (g: { dimensions: { datetimeMinute?: string; datetimeHour?: string } }): number => {
    const v = g.dimensions[timeDim as "datetimeHour"] ?? "";
    return new Date(v).getTime();
  };

  // Bucket message ops by actionType. The action axis includes things like
  // WriteMessage, ReadMessage, AckMessage, etc.; collapse them to friendly
  // produce/consume/ack categories so the chart stays readable.
  const PRODUCE = new Set(["WriteMessage", "WriteMessageBatch"]);
  const CONSUME = new Set(["ReadMessage", "ReadMessageBatch"]);
  const ACK = new Set(["AckMessage", "AckMessageBatch"]);
  const RETRY = new Set(["RetryMessage", "RetryMessageBatch"]);
  const produce = new Map<number, number>();
  const consume = new Map<number, number>();
  const ack = new Map<number, number>();
  const retry = new Map<number, number>();
  const other = new Map<number, number>();
  const bytes = new Map<number, number>();
  for (const g of ops) {
    const t = tsOf(g);
    if (Number.isNaN(t)) continue;
    const c = Number(g.count ?? 0);
    const b = Number(g.sum.bytes ?? 0);
    const a = g.dimensions.actionType;
    const bucket = PRODUCE.has(a)
      ? produce
      : CONSUME.has(a)
        ? consume
        : ACK.has(a)
          ? ack
          : RETRY.has(a)
            ? retry
            : other;
    bucket.set(t, (bucket.get(t) ?? 0) + c);
    bytes.set(t, (bytes.get(t) ?? 0) + b);
  }

  const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
    label,
    unit,
    points: [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value })),
  });

  const series: MetricSeries[] = [
    toSeries(produce, "Messages Produced", "messages"),
    toSeries(consume, "Messages Consumed", "messages"),
    toSeries(ack, "Messages Acknowledged", "messages"),
    toSeries(retry, "Messages Retried", "messages"),
    toSeries(other, "Other Operations", "operations"),
    toSeries(bytes, "Bytes Transferred", "bytes"),
  ];

  if (backlog.length > 0) {
    series.push({
      label: "Backlog Messages",
      unit: "messages",
      points: backlog.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avg.messages ?? 0),
      })),
    });
    series.push({
      label: "Backlog Bytes",
      unit: "bytes",
      points: backlog.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avg.bytes ?? 0),
      })),
    });
  }

  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Hyperdrive metrics via GraphQL `hyperdriveQueriesAdaptiveGroups`. Account
 * scoped, filter by `configId`. Resource id:
 * `${accountId}:hyperdrive:${configId}`.
 */
async function fetchHyperdriveMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const configId = resourceId.split(":").pop();
  if (!configId) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();
  const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
  const useHourly = windowMs >= 6 * 3_600_000;
  const timeDim = useHourly ? "datetimeHour" : "datetimeMinute";

  const query = `query H($account: String!, $config: string, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          hyperdriveQueriesAdaptiveGroups(
            limit: 10000
            filter: { configId: $config, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            count
            sum { queryBytes resultBytes }
            avg { queryLatency connectionLatency }
            dimensions { ${timeDim} cacheStatus eventStatus }
          }
        }
      }
    }`;

  interface Group {
    count?: number;
    sum: { queryBytes?: number; resultBytes?: number };
    avg: { queryLatency?: number; connectionLatency?: number };
    dimensions: {
      datetimeMinute?: string;
      datetimeHour?: string;
      cacheStatus: string;
      eventStatus: string;
    };
  }
  interface Resp {
    data?: { viewer?: { accounts?: Array<{ hyperdriveQueriesAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, config: configId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.accounts?.[0]?.hyperdriveQueriesAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const tsOf = (g: Group): number =>
    new Date(g.dimensions[timeDim as "datetimeHour"] ?? "").getTime();

  // Roll up cache hits/misses and errors separately so the user can see
  // cache effectiveness and reliability at a glance.
  const totalQueries = new Map<number, number>();
  const cacheHits = new Map<number, number>();
  const cacheMisses = new Map<number, number>();
  const errors = new Map<number, number>();
  const queryBytes = new Map<number, number>();
  const resultBytes = new Map<number, number>();
  const queryLatencySum = new Map<number, number>();
  const queryLatencyCount = new Map<number, number>();
  const connectionLatencySum = new Map<number, number>();
  const connectionLatencyCount = new Map<number, number>();

  for (const g of groups) {
    const t = tsOf(g);
    if (Number.isNaN(t)) continue;
    const c = Number(g.count ?? 0);
    totalQueries.set(t, (totalQueries.get(t) ?? 0) + c);
    if (g.dimensions.cacheStatus === "hit") {
      cacheHits.set(t, (cacheHits.get(t) ?? 0) + c);
    } else if (g.dimensions.cacheStatus === "miss") {
      cacheMisses.set(t, (cacheMisses.get(t) ?? 0) + c);
    }
    if (g.dimensions.eventStatus === "error") {
      errors.set(t, (errors.get(t) ?? 0) + c);
    }
    queryBytes.set(t, (queryBytes.get(t) ?? 0) + Number(g.sum.queryBytes ?? 0));
    resultBytes.set(t, (resultBytes.get(t) ?? 0) + Number(g.sum.resultBytes ?? 0));
    // Weighted average across groupings: sum (avg × count), divide by total count.
    const ql = Number(g.avg.queryLatency ?? 0);
    const cl = Number(g.avg.connectionLatency ?? 0);
    if (ql > 0) {
      queryLatencySum.set(t, (queryLatencySum.get(t) ?? 0) + ql * c);
      queryLatencyCount.set(t, (queryLatencyCount.get(t) ?? 0) + c);
    }
    if (cl > 0) {
      connectionLatencySum.set(t, (connectionLatencySum.get(t) ?? 0) + cl * c);
      connectionLatencyCount.set(t, (connectionLatencyCount.get(t) ?? 0) + c);
    }
  }

  const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
    label,
    unit,
    points: [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value })),
  });

  const avgSeries = (
    sums: Map<number, number>,
    counts: Map<number, number>,
    label: string,
    unit: string,
  ): MetricSeries => ({
    label,
    unit,
    points: [...sums.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, total]) => {
        const n = counts.get(timestamp) ?? 0;
        return { timestamp, value: n > 0 ? total / n : 0 };
      }),
  });

  const series: MetricSeries[] = [
    toSeries(totalQueries, "Queries", "queries"),
    toSeries(cacheHits, "Cache Hits", "queries"),
    toSeries(cacheMisses, "Cache Misses", "queries"),
    toSeries(errors, "Errors", "queries"),
    toSeries(queryBytes, "Query Bytes", "bytes"),
    toSeries(resultBytes, "Result Bytes", "bytes"),
    avgSeries(queryLatencySum, queryLatencyCount, "Query Latency", "ms"),
    avgSeries(connectionLatencySum, connectionLatencyCount, "Connection Latency", "ms"),
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * AI Gateway metrics via GraphQL `aiGatewayRequestsAdaptiveGroups`. Account
 * scoped, filtered by the `gateway` id. Surfaces the same four headline
 * numbers as the Cloudflare dashboard (requests, tokens, cost, errors) plus a
 * cache-hit series. Resource id: `${accountId}:ai-gateway:${gatewayId}`.
 */
async function fetchAiGatewayMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const gatewayId = resourceId.split(":").slice(2).join(":");
  if (!gatewayId) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();

  // The dataset's only documented time dimension is `datetimeHour`.
  const query = `query AIG($account: String!, $gateway: string, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          aiGatewayRequestsAdaptiveGroups(
            limit: 10000
            filter: { gateway: $gateway, datetimeHour_geq: $from, datetimeHour_leq: $to }
            orderBy: [datetimeHour_ASC]
          ) {
            count
            sum {
              cost
              cachedRequests
              erroredRequests
              uncachedTokensIn
              uncachedTokensOut
              cachedTokensIn
              cachedTokensOut
            }
            dimensions { datetimeHour }
          }
        }
      }
    }`;

  interface Group {
    count?: number;
    sum: {
      cost?: number;
      cachedRequests?: number;
      erroredRequests?: number;
      uncachedTokensIn?: number;
      uncachedTokensOut?: number;
      cachedTokensIn?: number;
      cachedTokensOut?: number;
    };
    dimensions: { datetimeHour?: string };
  }
  interface Resp {
    data?: { viewer?: { accounts?: Array<{ aiGatewayRequestsAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account: cfAccountId, gateway: gatewayId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const requests = new Map<number, number>();
  const tokensIn = new Map<number, number>();
  const tokensOut = new Map<number, number>();
  const cost = new Map<number, number>();
  const errors = new Map<number, number>();
  const cacheHits = new Map<number, number>();

  for (const g of groups) {
    const t = new Date(g.dimensions.datetimeHour ?? "").getTime();
    if (Number.isNaN(t)) continue;
    requests.set(t, (requests.get(t) ?? 0) + Number(g.count ?? 0));
    tokensIn.set(
      t,
      (tokensIn.get(t) ?? 0) +
        Number(g.sum.uncachedTokensIn ?? 0) +
        Number(g.sum.cachedTokensIn ?? 0),
    );
    tokensOut.set(
      t,
      (tokensOut.get(t) ?? 0) +
        Number(g.sum.uncachedTokensOut ?? 0) +
        Number(g.sum.cachedTokensOut ?? 0),
    );
    cost.set(t, (cost.get(t) ?? 0) + Number(g.sum.cost ?? 0));
    errors.set(t, (errors.get(t) ?? 0) + Number(g.sum.erroredRequests ?? 0));
    cacheHits.set(t, (cacheHits.get(t) ?? 0) + Number(g.sum.cachedRequests ?? 0));
  }

  const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
    label,
    unit,
    points: [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value })),
  });

  const series: MetricSeries[] = [
    toSeries(requests, "Requests", "requests"),
    toSeries(tokensIn, "Tokens In", "tokens"),
    toSeries(tokensOut, "Tokens Out", "tokens"),
    toSeries(cost, "Cost", "USD"),
    toSeries(errors, "Errors", "requests"),
    toSeries(cacheHits, "Cache Hits", "requests"),
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Load balancer metrics via GraphQL `loadBalancingRequestsAdaptiveGroups`.
 * Zone-scoped, filtered by `lbName`. The resource id encodes
 * `${zoneId}/${lbUuid}` — but the analytics dataset filters by name, not
 * UUID, so we resolve the name via the SDK first.
 * Resource id: `${accountId}:load-balancer:${zoneId}/${lbUuid}`.
 */
async function fetchLoadBalancerMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const lastSegment = resourceId.split(":").pop();
  if (!lastSegment) return [];
  const slashIdx = lastSegment.indexOf("/");
  if (slashIdx === -1) return [];
  const zoneId = lastSegment.slice(0, slashIdx);
  const lbUuid = lastSegment.slice(slashIdx + 1);
  if (!zoneId || !lbUuid) return [];

  // The GraphQL filter for loadBalancingRequestsAdaptiveGroups uses lbName
  // (the LB hostname / configured name) rather than UUID. Look it up.
  let lbName = "";
  try {
    const lb = (await api.cf.loadBalancers.get(lbUuid, {
      zone_id: zoneId,
    })) as unknown as Record<string, unknown>;
    lbName = String(lb["name"] ?? "");
  } catch {
    return [];
  }
  if (!lbName) return [];

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();
  // LB analytics is sampled in fifteen-minute buckets; coarser windows roll
  // up via the same dimension since it is the finest granularity exposed.
  const timeDim = "datetimeFifteenMinutes";

  const query = `query L($zone: String!, $lb: string, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          loadBalancingRequestsAdaptiveGroups(
            limit: 10000
            filter: { lbName: $lb, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            count
            dimensions { ${timeDim} selectedPoolName coloCode }
          }
        }
      }
    }`;

  interface Group {
    count?: number;
    dimensions: {
      datetimeFifteenMinutes: string;
      selectedPoolName: string;
      coloCode: string;
    };
  }
  interface Resp {
    data?: { viewer?: { zones?: Array<{ loadBalancingRequestsAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { zone: zoneId, lb: lbName, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.zones?.[0]?.loadBalancingRequestsAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const tsOf = (g: Group): number => new Date(g.dimensions.datetimeFifteenMinutes).getTime();

  // Aggregate total requests per bucket, plus per-pool series so the user
  // can see how the LB is distributing traffic.
  const totalReqs = new Map<number, number>();
  const perPool = new Map<string, Map<number, number>>();
  for (const g of groups) {
    const t = tsOf(g);
    if (Number.isNaN(t)) continue;
    const c = Number(g.count ?? 0);
    totalReqs.set(t, (totalReqs.get(t) ?? 0) + c);
    const pool = g.dimensions.selectedPoolName || "unassigned";
    let m = perPool.get(pool);
    if (!m) {
      m = new Map();
      perPool.set(pool, m);
    }
    m.set(t, (m.get(t) ?? 0) + c);
  }

  const toSeries = (m: Map<number, number>, label: string, unit: string): MetricSeries => ({
    label,
    unit,
    points: [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value })),
  });

  const series: MetricSeries[] = [toSeries(totalReqs, "Requests", "requests")];
  for (const [pool, m] of perPool) {
    series.push(toSeries(m, `Pool: ${pool}`, "requests"));
  }
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Waiting room metrics via GraphQL `waitingRoomAnalyticsAdaptiveGroups`.
 * Zone-scoped, filter by `waitingRoomId`. Resource id:
 * `${accountId}:waiting-room:${zoneId}/${roomId}`.
 */
async function fetchWaitingRoomMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const lastSegment = resourceId.split(":").pop();
  if (!lastSegment) return [];
  const slashIdx = lastSegment.indexOf("/");
  if (slashIdx === -1) return [];
  const zoneId = lastSegment.slice(0, slashIdx);
  const roomId = lastSegment.slice(slashIdx + 1);
  if (!zoneId || !roomId) return [];

  const now = Date.now();
  const from = new Date(timeRange?.startMs ?? now - 24 * 3_600_000).toISOString();
  const to = new Date(timeRange?.endMs ?? now).toISOString();
  const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 24 * 3_600_000);
  // Waiting Room analytics exposes 15-minute and 1-hour buckets.
  const useHourly = windowMs >= 6 * 3_600_000;
  const timeDim = useHourly ? "datetimeHour" : "datetimeFifteenMinutes";

  const query = `query W($zone: String!, $room: string, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          waitingRoomAnalyticsAdaptiveGroups(
            limit: 10000
            filter: { waitingRoomId: $room, datetime_geq: $from, datetime_leq: $to }
            orderBy: [${timeDim}_ASC]
          ) {
            avg { totalActiveUsers totalQueuedUsers newUsersPerMinute }
            avgWeighted { timeOnOriginP50 totalTimeWaitedP90 }
            dimensions { ${timeDim} }
          }
        }
      }
    }`;

  interface Group {
    avg: {
      totalActiveUsers?: number;
      totalQueuedUsers?: number;
      newUsersPerMinute?: number;
    };
    avgWeighted: { timeOnOriginP50?: number; totalTimeWaitedP90?: number };
    dimensions: { datetimeFifteenMinutes?: string; datetimeHour?: string };
  }
  interface Resp {
    data?: { viewer?: { zones?: Array<{ waitingRoomAnalyticsAdaptiveGroups?: Group[] }> } };
  }

  let groups: Group[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { zone: zoneId, room: roomId, from, to },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    groups = json.data?.viewer?.zones?.[0]?.waitingRoomAnalyticsAdaptiveGroups ?? [];
  } catch {
    return [];
  }
  if (groups.length === 0) return [];

  const tsOf = (g: Group): number => {
    const v = g.dimensions[timeDim as "datetimeHour"] ?? "";
    return new Date(v).getTime();
  };

  const series: MetricSeries[] = [
    {
      label: "Active Users",
      unit: "users",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avg.totalActiveUsers ?? 0),
      })),
    },
    {
      label: "Queued Users",
      unit: "users",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avg.totalQueuedUsers ?? 0),
      })),
    },
    {
      label: "New Users / Minute",
      unit: "users/min",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avg.newUsersPerMinute ?? 0),
      })),
    },
    {
      label: "Time on Origin p50",
      unit: "seconds",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avgWeighted.timeOnOriginP50 ?? 0),
      })),
    },
    {
      label: "Time Waited p90",
      unit: "seconds",
      points: groups.map((g) => ({
        timestamp: tsOf(g),
        value: Number(g.avgWeighted.totalTimeWaitedP90 ?? 0),
      })),
    },
  ];
  return series.filter((s) => s.points.some((p) => p.value > 0));
}

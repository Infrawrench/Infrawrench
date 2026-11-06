/**
 * Post notable instance changes to Bluesky and X after a sync: new instance
 * types, retirements, big on-demand and spot price moves, and families
 * arriving in new regions. Run by `scripts/sync-aws-bulk-pricing.ts`.
 *
 * What changed comes from the warehouse. Before the sync, {@link cursors}
 * reads each source's `sync_state.price_list_to`; after it, every source the
 * sync loaded is queried for rows newer than that. A source with no earlier
 * cursor (a first load, or a reload after a schema bump) is skipped, so a
 * reload never posts years of history.
 *
 * Until `SOCIAL_POST=1`, nothing is posted: the posts are logged and written
 * to the job summary, so the thresholds can be tuned from real runs first.
 */

import { createHmac, randomBytes } from "node:crypto";

import type { ClickHouseHttp } from "./warehouse";

const SITE = "https://instances.infrawrench.com";

/** On-demand moves at least this big (either way) are posted. */
export const ON_DEMAND_THRESHOLD = 0.1;
/** Spot moves at least this big are posted. */
export const SPOT_THRESHOLD = 0.5;
/** Posts per run; the rest go in one summary post. */
export const MAX_POSTS = 5;

/** Sources whose changes are never posted. */
const UNPOSTED_SOURCES: ReadonlySet<string> = new Set(["hetznerauction"]);

/** Where each platform's pages live on the instances site, and what posts call it. */
const PLATFORM_PAGES: Readonly<Record<string, { path: string; label: string }>> = {
  ec2: { path: "aws/ec2", label: "AWS EC2" },
  rds: { path: "aws/rds", label: "AWS RDS" },
  elasticache: { path: "aws/elasticache", label: "AWS ElastiCache" },
  opensearch: { path: "aws/opensearch", label: "AWS OpenSearch" },
  redshift: { path: "aws/redshift", label: "AWS Redshift" },
  docdb: { path: "aws/docdb", label: "AWS DocumentDB" },
  neptune: { path: "aws/neptune", label: "AWS Neptune" },
  memorydb: { path: "aws/memorydb", label: "AWS MemoryDB" },
  dax: { path: "aws/dax", label: "AWS DAX" },
  sagemaker: { path: "aws/sagemaker", label: "AWS SageMaker" },
  emr: { path: "aws/emr", label: "AWS EMR" },
  gamelift: { path: "aws/gamelift", label: "AWS GameLift" },
  runpod: { path: "runpod/pods", label: "RunPod" },
  alibaba: { path: "alibaba/ecs", label: "Alibaba Cloud ECS" },
  azure: { path: "azure/vms", label: "Azure" },
  gcp: { path: "gcp/compute", label: "Google Cloud" },
  hetzner: { path: "hetzner/cloud", label: "Hetzner Cloud" },
  hetznerauction: { path: "hetzner/auction", label: "Hetzner Server Auction" },
  ovh: { path: "ovh/cloud", label: "OVHcloud Public Cloud" },
  ovheco: { path: "ovh/eco", label: "OVHcloud eco servers" },
  oracle: { path: "oracle/compute", label: "Oracle Cloud Compute" },
  ibm: { path: "ibm/vpc", label: "IBM Cloud VPC" },
};

const pageOf = (platform: string) =>
  PLATFORM_PAGES[platform] ?? { path: `aws/${platform}`, label: `AWS ${platform}` };

export function instanceUrl(platform: string, name: string): string {
  return `${SITE}/${pageOf(platform).path}/${encodeURIComponent(name)}`;
}

export function platformUrl(platform: string): string {
  return `${SITE}/${pageOf(platform).path}`;
}

export type Change =
  | {
      kind: "new";
      platform: string;
      name: string;
      vcpu: number | null;
      memory: number | null;
      gpus: number | null;
      gpuModel: string;
    }
  | { kind: "retired"; platform: string; name: string }
  | {
      kind: "price";
      platform: string;
      name: string;
      spot: boolean;
      region: string;
      from: number;
      to: number;
      regions: number;
    }
  | { kind: "region"; platform: string; family: string; region: string; types: number };

/** Each source's newest price list as of now: what the next run looks for changes after. */
export async function cursors(ch: ClickHouseHttp): Promise<Map<string, string>> {
  const rows = await ch.rows<{ source: string; price_list_to: string | null }>(
    "SELECT source, price_list_to FROM sync_state",
  );
  return new Map(
    rows.filter((r) => r.price_list_to).map((r) => [r.source, r.price_list_to as string]),
  );
}

const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * The variant columns of a price, so a product's new price is compared with
 * the same product's previous one.
 */
const PRODUCT = `cityHash64(platform, instance_type, region, pricing, lease, offering_class, purchase_option,
  operating_system, tenancy, license_model, pre_installed_sw, capacity_status, database_engine,
  database_edition, deployment_option, deployment_model, engine_media_type, cache_engine,
  software_type, component, usage_type, variant)`;

/** The headline price only: Linux, shared, nothing bundled, standard priority. */
const HEADLINE = `operating_system IN ('', 'Linux') AND tenancy IN ('', 'Shared')
  AND pre_installed_sw IN ('', 'NA') AND capacity_status IN ('', 'Used')
  AND license_model IN ('', 'No License required', 'No license required')
  AND variant['priority'] IN ('', 'Regular') AND variant['provisioningModel'] IN ('', 'Standard')`;

/** What changed in one source since `since` (a `price_list_to` from {@link cursors}). */
export async function changesSince(
  ch: ClickHouseHttp,
  source: string,
  since: string,
): Promise<Change[]> {
  // Auction listings come and go, and fall in price, all the time: none of that is news.
  if (UNPOSTED_SOURCES.has(source)) return [];
  const src = quote(source);
  const after = `toDateTime(${quote(since)}, 'UTC')`;
  const changes: Change[] = [];

  if (source !== "spot") {
    const added = await ch.rows<{
      platform: string;
      instance_type: string;
      vcpu: number | null;
      memory_gib: number | null;
      gpus: number | null;
      gpu_model: string;
    }>(
      `SELECT platform, instance_type, vcpu, memory_gib, gpus, gpu_model FROM instance_types
       WHERE source = ${src} AND first_listed > ${after} AND retired_at IS NULL`,
    );
    for (const r of added)
      changes.push({
        kind: "new",
        platform: r.platform,
        name: r.instance_type,
        vcpu: r.vcpu === null ? null : Number(r.vcpu),
        memory: r.memory_gib === null ? null : Number(r.memory_gib),
        gpus: r.gpus === null ? null : Number(r.gpus),
        gpuModel: r.gpu_model,
      });

    const retired = await ch.rows<{ platform: string; instance_type: string }>(
      `SELECT platform, instance_type FROM instance_types
       WHERE source = ${src} AND retired_at > ${after}`,
    );
    for (const r of retired)
      changes.push({ kind: "retired", platform: r.platform, name: r.instance_type });

    // A family's first price in a region, for families already sold elsewhere.
    const regions = await ch.rows<{
      platform: string;
      family: string;
      region: string;
      types: string;
    }>(
      `SELECT platform, family, region, uniqExact(instance_type) AS types FROM prices
       WHERE source = ${src} AND pricing = 'on_demand' AND family != '' AND region NOT IN ('', 'global', 'Global')
       GROUP BY platform, family, region
       HAVING min(valid_from) > ${after}
         AND (platform, family) IN (
           SELECT platform, family FROM prices WHERE source = ${src} AND valid_from <= ${after}
         )`,
    );
    for (const r of regions)
      changes.push({
        kind: "region",
        platform: r.platform,
        family: r.family,
        region: r.region,
        types: Number(r.types),
      });
  }

  // Prices that replaced an earlier one for the same product, by enough to matter.
  const moves = await ch.rows<{
    platform: string;
    instance_type: string;
    pricing: string;
    top_region: string;
    old_usd: number;
    new_usd: number;
    regions: string;
  }>(
    // The alias must not be `region`: ClickHouse would expand `uniqExact(region)`
    // with it and reject the aggregate inside an aggregate.
    `SELECT platform, instance_type, pricing,
       argMax(region, abs(change)) AS top_region, argMax(old, abs(change)) AS old_usd,
       argMax(new, abs(change)) AS new_usd, uniqExact(region) AS regions
     FROM (
       SELECT n.platform AS platform, n.instance_type AS instance_type, n.pricing AS pricing,
         n.region AS region, o.hourly_usd AS old, n.hourly_usd AS new,
         n.hourly_usd / o.hourly_usd - 1 AS change
       FROM (
         SELECT ${PRODUCT} AS product, platform, instance_type, pricing, region, hourly_usd, valid_from
         FROM prices
         WHERE source = ${src} AND current AND valid_from > ${after}
           AND pricing IN ('on_demand', 'spot') AND hourly_usd > 0 AND ${HEADLINE}
       ) AS n
       INNER JOIN (
         SELECT ${PRODUCT} AS product, hourly_usd, valid_to
         FROM prices
         WHERE source = ${src} AND valid_to > ${after}
           AND pricing IN ('on_demand', 'spot') AND hourly_usd > 0 AND ${HEADLINE}
       ) AS o ON n.product = o.product AND n.valid_from = o.valid_to
       WHERE abs(change) >= if(pricing = 'spot', ${SPOT_THRESHOLD}, ${ON_DEMAND_THRESHOLD})
     )
     GROUP BY platform, instance_type, pricing, change > 0`,
  );
  for (const r of moves)
    changes.push({
      kind: "price",
      platform: r.platform,
      name: r.instance_type,
      spot: r.pricing === "spot",
      region: r.top_region,
      from: Number(r.old_usd),
      to: Number(r.new_usd),
      regions: Number(r.regions),
    });
  return changes;
}

/** Biggest news first: launches, then the largest price moves, retirements, regions. */
export function rank(changes: Change[]): Change[] {
  const score = (c: Change) => {
    switch (c.kind) {
      case "new":
        return 4;
      case "price":
        return 2 + Math.min(Math.abs(c.to / c.from - 1), 1) + Math.min(c.regions, 10) / 100;
      case "retired":
        return 1.5;
      case "region":
        return 1 + Math.min(c.types, 50) / 100;
    }
  };
  return [...changes].sort((a, b) => score(b) - score(a));
}

const usd = (n: number) =>
  `$${n < 1 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}/hr`;

function specs(c: Extract<Change, { kind: "new" }>): string {
  const parts: string[] = [];
  if (c.vcpu !== null) parts.push(`${c.vcpu} vCPU${c.vcpu === 1 ? "" : "s"}`);
  if (c.memory !== null) parts.push(`${c.memory} GiB`);
  if (c.gpus) parts.push(`${c.gpus} x ${c.gpuModel || "GPU"}`);
  return parts.join(", ");
}

export interface Post {
  text: string;
  /** The link in the text, for Bluesky's link facet and card. */
  url: string;
}

/** One post per change: plain text with its page link at the end, under 280 characters. */
export function compose(c: Change): Post {
  const label = pageOf(c.platform).label;
  let text: string;
  let url: string;
  switch (c.kind) {
    case "new": {
      const s = specs(c);
      text = `New on ${label}: ${c.name}${s ? `, ${s}` : ""}.`;
      url = instanceUrl(c.platform, c.name);
      break;
    }
    case "retired":
      text = `${label} has dropped ${c.name} from its price list.`;
      url = instanceUrl(c.platform, c.name);
      break;
    case "price": {
      const pct = Math.round(Math.abs(c.to / c.from - 1) * 100);
      const dir = c.to > c.from ? "up" : "down";
      const what = c.spot ? `${c.name} spot` : `${c.name} on-demand`;
      const where =
        c.regions > 1 ? `in ${c.regions} regions, most in ${c.region}` : `in ${c.region}`;
      text = `${label} ${what} price ${dir} ${pct}% ${where}: ${usd(c.from)} to ${usd(c.to)}.`;
      url = instanceUrl(c.platform, c.name);
      break;
    }
    case "region":
      text = `${label} ${c.family} is now available in ${c.region} (${c.types} size${c.types === 1 ? "" : "s"}).`;
      url = platformUrl(c.platform);
      break;
  }
  return { text: `${text}\n\n${url}`, url };
}

/** The run's posts: the top {@link MAX_POSTS} changes, and one post for the rest. */
export function plan(changes: Change[]): Post[] {
  const ranked = rank(changes);
  const posts = ranked.slice(0, MAX_POSTS).map(compose);
  const rest = ranked.length - posts.length;
  if (rest > 0) {
    posts.push({
      text: `Plus ${rest} more instance change${rest === 1 ? "" : "s"} in the latest cloud price lists.\n\n${SITE}`,
      url: SITE,
    });
  }
  return posts;
}

// ── Bluesky ──

export interface BlueskyConfig {
  identifier: string;
  password: string;
  service?: string;
  fetch?: typeof fetch;
}

/** Post to Bluesky with an app password; the link becomes a facet and a card. */
export async function postBluesky(config: BlueskyConfig, posts: Post[]): Promise<void> {
  const service = config.service ?? "https://bsky.social";
  const f = config.fetch ?? fetch;
  const session = await f(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: config.identifier, password: config.password }),
  });
  if (!session.ok) throw new Error(`bluesky: sign in failed: HTTP ${session.status}`);
  const { accessJwt, did } = (await session.json()) as { accessJwt: string; did: string };
  for (const post of posts) {
    const res = await f(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessJwt}` },
      body: JSON.stringify({
        repo: did,
        collection: "app.bsky.feed.post",
        record: blueskyRecord(post),
      }),
    });
    if (!res.ok) throw new Error(`bluesky: post failed: HTTP ${res.status} ${await res.text()}`);
  }
}

export function blueskyRecord(post: Post, now = new Date()) {
  const bytes = new TextEncoder();
  const start = bytes.encode(post.text.slice(0, post.text.lastIndexOf(post.url))).length;
  return {
    $type: "app.bsky.feed.post",
    text: post.text,
    createdAt: now.toISOString(),
    langs: ["en"],
    facets: [
      {
        index: { byteStart: start, byteEnd: start + bytes.encode(post.url).length },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: post.url }],
      },
    ],
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: post.url,
        title: "Infrawrench Instances",
        description: post.text.split("\n")[0],
      },
    },
  };
}

// ── X ──

export interface XConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  fetch?: typeof fetch;
}

const TWEETS_URL = "https://api.x.com/2/tweets";

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
const pct = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** An OAuth 1.0a HMAC-SHA1 signature over the method, URL and parameters. */
export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const normalized = Object.keys(params)
    .map((k) => [pct(k), pct(params[k]!)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(normalized)}`;
  return createHmac("sha1", `${pct(consumerSecret)}&${pct(tokenSecret)}`)
    .update(base)
    .digest("base64");
}

function oauthHeader(config: XConfig, method: string, url: string): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: config.accessToken,
    oauth_version: "1.0",
  };
  // A JSON body is not part of the signature.
  oauth["oauth_signature"] = oauthSignature(
    method,
    url,
    oauth,
    config.apiSecret,
    config.accessTokenSecret,
  );
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${pct(k)}="${pct(oauth[k]!)}"`)
    .join(", ")}`;
}

/** Post to X as the account the access token belongs to. */
export async function postX(config: XConfig, posts: Post[]): Promise<void> {
  const f = config.fetch ?? fetch;
  for (const post of posts) {
    const res = await f(TWEETS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: oauthHeader(config, "POST", TWEETS_URL),
      },
      body: JSON.stringify({ text: post.text }),
    });
    if (!res.ok) throw new Error(`x: post failed: HTTP ${res.status} ${await res.text()}`);
  }
}

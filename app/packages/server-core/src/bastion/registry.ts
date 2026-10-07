/**
 * In-memory registry of currently-connected bastion agents.
 *
 * The web process accepts WS connections from bastion-agent containers; each
 * connection registers itself here so plugin HTTP code can resolve a
 * `Dispatcher` by bastion id. The map is single-process; for multi-instance
 * routing we'd need cross-process lookup (out of scope for v1, but the
 * `Promise<Dispatcher | null>` interface makes the swap local).
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { accounts, bastionVms } from "../db/schema.js";
import { BastionAgentConnection } from "./dispatcher.js";

export { BastionAgentConnection };

const connections = new Map<string, BastionAgentConnection>();

/** Register a freshly authenticated agent. Replaces any prior connection for the same bastion. */
export async function registerAgentConnection(conn: BastionAgentConnection): Promise<void> {
  const prior = connections.get(conn.bastionId);
  if (prior) {
    await prior.destroy(new Error("Replaced by a newer agent connection"));
  }
  connections.set(conn.bastionId, conn);
  await refreshAllowlistFromDb(conn);
}

/** Drop an agent from the registry (called on WS close). */
export async function unregisterAgentConnection(bastionId: string): Promise<void> {
  const conn = connections.get(bastionId);
  if (!conn) return;
  connections.delete(bastionId);
  await conn.destroy();
}

/**
 * Return the dispatcher for `bastionId` if an agent is currently connected.
 * `null` ⇒ bastion is bound but offline: callers should surface
 * `BastionDisconnectedError` rather than falling back to direct egress.
 */
export function getDispatcherFor(bastionId: string): import("undici").Dispatcher | null {
  const conn = connections.get(bastionId);
  return conn?.dispatcher ?? null;
}

/** `true` when an agent is live for this bastion. Used by status endpoints. */
export function isBastionConnected(bastionId: string): boolean {
  return connections.has(bastionId);
}

/**
 * Recompute and push the destination allowlist to the agent. Called when
 * accounts referencing this bastion change.
 */
export async function refreshAllowlistFromDb(conn: BastionAgentConnection): Promise<void> {
  const rows = await db
    .select({ pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.bastionId, conn.bastionId)));
  const plugins = new Set(rows.map((r) => r.pluginId));
  conn.setAllowlist(allowlistForPlugins(plugins));
}

/**
 * Map plugin ids → wildcard hostnames the agent should permit. Conservative
 * by design: each plugin contributes only the cloud-control-plane suffixes
 * it actually calls, so a compromised backend can't ask the agent to fetch
 * `169.254.169.254` or arbitrary user URLs.
 *
 * Entries starting with `*.` are suffix matches.
 */
export function allowlistForPlugins(pluginIds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const id of pluginIds) {
    for (const host of PLUGIN_ALLOWLIST[id] ?? []) out.add(host);
  }
  return [...out];
}

const PLUGIN_ALLOWLIST: Record<string, string[]> = {
  tailscale: ["api.tailscale.com"],
  aws: ["*.amazonaws.com", "*.aws.amazon.com"],
  gcp: ["*.googleapis.com", "*.google.com"],
  azure: [
    "*.azure.com",
    "*.windows.net",
    "*.microsoftonline.com",
    "management.azure.com",
    "login.microsoftonline.com",
  ],
  digitalocean: ["api.digitalocean.com"],
  hetzner: ["api.hetzner.cloud", "robot-ws.your-server.de"],
  // The REST API, Cloud Pulse metrics, and the pre-signed Object Storage
  // URLs the bucket browser uploads to and deletes through.
  linode: ["api.linode.com", "monitor-api.linode.com", "*.linodeobjects.com"],
  fly: ["api.machines.dev", "api.fly.io"],
  vercel: ["api.vercel.com"],
  // api.github.com, or api.<subdomain>.ghe.com for data residency. Copilot
  // metrics reports are signed download links on GitHub-owned hosts.
  github: ["api.github.com", "*.ghe.com", "*.githubusercontent.com"],
  netlify: ["api.netlify.com"],
  planetscale: ["api.planetscale.com"],
  // REST API, plus the subscriptions' Prometheus endpoints on the internal network.
  "redis-cloud": ["api.redislabs.com", "*.rlrcp.com"],
  cloudflare: ["api.cloudflare.com"],
  cloudinary: ["api.cloudinary.com"],
  crusoe: ["api.cloud.crusoe.ai"],
  baseten: ["api.baseten.co"],
  databricks: ["*.cloud.databricks.com", "*.azuredatabricks.net", "*.gcp.databricks.com"],
  depot: ["api.depot.dev"],
  neon: ["console.neon.tech"],
  newrelic: ["api.newrelic.com", "api.eu.newrelic.com", "api.jp.newrelic.com"],
  metronome: ["api.metronome.com"],
  sentry: ["sentry.io", "us.sentry.io", "de.sentry.io"],
  "mongodb-atlas": ["cloud.mongodb.com"],
  snowflake: ["*.snowflakecomputing.com"],
  // Usage export files download from presigned S3 links (bucket and region
  // are CircleCI's choice, so the whole S3 suffix).
  circleci: ["circleci.com", "runner.circleci.com", "*.amazonaws.com"],
  turso: ["api.turso.tech"],
  ovh: ["*.ovh.com"],
  // Every OCI service host sits under oraclecloud.com (identity, iaas,
  // database, objectstorage, telemetry, usageapi, usage, limits, query,
  // containerengine); the public price list is on apexapps.oracle.com.
  "oracle-cloud": ["*.oraclecloud.com", "apexapps.oracle.com"],
  scaleway: ["api.scaleway.com", "*.scw.cloud"],
  vultr: ["api.vultr.com"],
  anthropic: ["api.anthropic.com"],
  anyscale: ["console.anyscale.com"],
  assemblyai: ["api.assemblyai.com", "api.eu.assemblyai.com"],
  cartesia: ["api.cartesia.ai"],
  cohere: ["api.cohere.com"],
  coralogix: [
    "api.eu1.coralogix.com",
    "api.eu2.coralogix.com",
    "api.us1.coralogix.com",
    "api.us2.coralogix.com",
    "api.us3.coralogix.com",
    "api.ap1.coralogix.com",
    "api.ap2.coralogix.com",
    "api.ap3.coralogix.com",
    "api.gov1.coralogixgov.us",
  ],
  // Cloud API, observability API and every CKS cluster API server
  // (`{org}-{hash}.k8s.{zone}.coreweave.com`); bucket data is on cwobject.com.
  coreweave: ["*.coreweave.com", "cwobject.com", "*.cwobject.com"],
  cursor: ["api.cursor.com"],
  datadog: [
    "api.datadoghq.com",
    "api.us3.datadoghq.com",
    "api.us5.datadoghq.com",
    "api.datadoghq.eu",
    "api.ap1.datadoghq.com",
    "api.ap2.datadoghq.com",
    "api.uk1.datadoghq.com",
    "api.ddog-gov.com",
    "api.us2.ddog-gov.com",
  ],
  deepgram: ["api.deepgram.com"],
  "elastic-cloud": ["api.elastic-cloud.com", "billing.elastic-cloud.com"],
  modal: ["api.modal.com"],
  deepseek: ["api.deepseek.com"],
  devin: ["api.devin.ai"],
  elevenlabs: [
    "api.elevenlabs.io",
    "api.us.elevenlabs.io",
    "api.eu.residency.elevenlabs.io",
    "api.in.residency.elevenlabs.io",
    "api.sg.residency.elevenlabs.io",
  ],
  fastly: ["api.fastly.com", "rt.fastly.com"],
  fireworks: ["api.fireworks.ai"],
  "confluent-cloud": ["api.confluent.cloud", "api.telemetry.confluent.cloud"],
  gemini: ["generativelanguage.googleapis.com"],
  gladia: ["api.gladia.io"],
  // Cloud API on grafana.com; each stack's Grafana, Prometheus and Synthetic
  // Monitoring APIs live under grafana.net.
  "grafana-cloud": ["grafana.com", "*.grafana.net"],
  groq: ["api.groq.com"],
  mistral: ["api.mistral.ai"],
  openai: ["api.openai.com", "mtls.api.openai.com", "mtls-eu.api.openai.com"],
  openrouter: ["openrouter.ai"],
  replicate: ["api.replicate.com", "replicate.delivery"],
  revai: ["api.rev.ai", "ec1.api.rev.ai"],
  speechmatics: [
    "*.asr.api.speechmatics.com",
    "mp.api.speechmatics.com",
    "portal.speechmatics.com",
  ],
  "temporal-cloud": ["saas-api.tmprl.cloud", "metrics.temporal.io"],
  together: ["api.together.ai", "api.together.xyz", "api-inference.together.ai"],
  xai: ["api.x.ai", "management-api.x.ai"],
  // Control plane, the per-app file-serving host, and the regional ingest
  // endpoints presigned uploads PUT to.
  uploadthing: ["api.uploadthing.com", "*.ufs.sh", "*.ingest.uploadthing.com", "utfs.io"],
  workos: ["api.workos.com"],
  twilio: ["api.twilio.com", "messaging.twilio.com", "verify.twilio.com", "pricing.twilio.com"],
  kubernetes: [], // kubeconfig-relative; v1 doesn't bastion-route Kubernetes
  postmark: ["api.postmarkapp.com"],
  // REST management API, GraphQL (account, GPU types, SSH keys) and the Serverless queue API
  runpod: ["rest.runpod.io", "api.runpod.io", "api.runpod.ai"],
  render: ["api.render.com"],
  stripe: ["api.stripe.com"],
  // *.supabase.co is each project's own gateway, used for the Storage API
  supabase: ["api.supabase.com", "*.supabase.co"],
  resend: ["api.resend.com"],
  // *.convex.cloud is each deployment's own Deployment API (regional hosts included)
  convex: ["api.convex.dev", "*.convex.cloud"],
  railway: ["backboard.railway.com"],
  // GitLab.com only; self-managed instances are user-supplied hosts and are not bastion-routed
  gitlab: ["gitlab.com"],
  // api.civo.com is the management API; Object Store endpoints are objectstore.<region>.civo.com
  civo: ["api.civo.com", "*.civo.com"],
  // *.xata.tech is each branch's own SQL gateway host ({branch}.{region}.xata.tech)
  xata: ["api.xata.tech", "*.xata.tech"],
  // *.heroku.com covers the one-off log session URLs the API returns
  heroku: ["api.heroku.com", "*.heroku.com"],
  // REST API (US and EU service regions) and the Events API v2 the paging capability sends alerts through.
  pagerduty: [
    "api.pagerduty.com",
    "api.eu.pagerduty.com",
    "events.pagerduty.com",
    "events.eu.pagerduty.com",
  ],
  // finished Pipelines step logs redirect (307) to S3 long-term storage
  bitbucket: ["api.bitbucket.org", "*.s3.amazonaws.com"],
  "cockroachdb-cloud": ["cockroachlabs.cloud"],
  northflank: ["api.northflank.com"],
  upcloud: ["api.upcloud.com"],
  "incident-io": ["api.incident.io"],
  koyeb: ["app.koyeb.com"],
  // api.eu.sendgrid.com serves EU regional subusers
  sendgrid: ["api.sendgrid.com", "api.eu.sendgrid.com"],
  "lambda-cloud": ["cloud.lambda.ai"],
  // Developer API plus the two regional QStash APIs
  upstash: ["api.upstash.com", "qstash-eu-central-1.upstash.io", "qstash-us-east-1.upstash.io"],
  // api.eu.mailgun.net holds EU-region domains
  mailgun: ["api.mailgun.net", "api.eu.mailgun.net"],
  // Tiger Cloud (Timescale) REST API; the timescale.com host is the legacy alias
  timescale: ["console.cloud.tigerdata.com", "console.cloud.timescale.com"],
  exoscale: ["*.exoscale.com", "*.exo.io"],
  // Every OpenAPI product and OSS live under aliyuncs.com (regional and central endpoints); the status feed is on status.alibabacloud.com
  "alibaba-cloud": ["*.aliyuncs.com", "status.alibabacloud.com"],
  // index and assistant data-plane hosts are per-resource subdomains of pinecone.io; login.pinecone.io issues Admin API tokens
  pinecone: ["api.pinecone.io", "login.pinecone.io", "*.pinecone.io"],
  "vast-ai": ["console.vast.ai"],
  aiven: ["api.aiven.io"],
  // B2 hands out a per-cluster apiNNN/fNNN/podNNN host at authorize time
  "backblaze-b2": ["api.backblazeb2.com", "*.backblazeb2.com"],
  paperspace: ["api.paperspace.com"],
  // Astra DevOps/streaming APIs, the metrics scrape host, and each database's Data API endpoint
  "datastax-astra": [
    "api.astra.datastax.com",
    "api.streaming.datastax.com",
    "metrics.astra.datastax.com",
    "*.apps.astra.datastax.com",
  ],
  // cluster database endpoints are per-cluster subdomains of cloud.qdrant.io (port 6333); hybrid clusters use the customer's own endpoint
  "qdrant-cloud": ["api.cloud.qdrant.io", "*.cloud.qdrant.io"],
  // Honeycomb US and EU API hosts (configuration and management keys share them).
  honeycomb: ["api.honeycomb.io", "api.eu1.honeycomb.io"],
  // IAM, VPC (*.iaas.cloud.ibm.com), Kubernetes Service, Code Engine, Cloud Databases, Resource Controller, billing, COS config and the status feed are under cloud.ibm.com; COS S3 endpoints are under cloud-object-storage.appdomain.cloud
  "ibm-cloud": ["iam.cloud.ibm.com", "*.cloud.ibm.com", "*.cloud-object-storage.appdomain.cloud"],
  // SaaS environment API (live) and Grail (apps); SSO + Account Management API for DPS cost. Managed clusters and ActiveGates are user-supplied hosts.
  dynatrace: [
    "*.live.dynatrace.com",
    "*.apps.dynatrace.com",
    "*.dynatracelabs.com",
    "sso.dynatrace.com",
    "api.dynatrace.com",
  ],
  // s3.<region>, iam, stats and partner (Account Control) hosts
  wasabi: ["*.wasabisys.com"],
  // each account is one cluster endpoint: Weaviate Cloud clusters live under weaviate.cloud (older ones weaviate.network); self-hosted endpoints are user-supplied
  "weaviate-cloud": ["*.weaviate.cloud", "*.weaviate.network"],
  // user-supplied endpoint; v1 doesn't bastion-route self-hosted S3
  "s3-compatible": [],
  "couchbase-capella": ["cloudapi.cloud.couchbase.com"],
  // Management API plus the edge deployments (us-east-1.aws.edge.axiom.co, eu-central-1.aws.edge.axiom.co) that APL queries run on.
  axiom: ["api.axiom.co", "*.edge.axiom.co"],
  // search hosts are per-application ({appId}-dsn.algolia.net plus algolianet.com fallbacks); analytics, usage, monitoring and crawler APIs each have their own host
  algolia: [
    "*.algolia.net",
    "*.algolianet.com",
    "analytics.algolia.com",
    "analytics.us.algolia.com",
    "analytics.de.algolia.com",
    "usage.algolia.com",
    "status.algolia.com",
    "crawler.algolia.com",
  ],
  // api.<realm> for REST, stream.<realm> for SignalFlow; signalfx.com is the legacy alias of the same hosts.
  "splunk-observability": ["*.observability.splunkcloud.com", "*.signalfx.com"],
  buildkite: ["api.buildkite.com"],
  // InfluxDB Cloud regional v2 API hosts and the Cloud Dedicated Management API
  "influxdb-cloud": ["*.cloud2.influxdata.com", "console.influxdata.com"],
  // Edge Storage answers on the zone's regional storage host
  bunny: ["api.bunny.net", "storage.bunnycdn.com", "*.storage.bunnycdn.com"],
  // platform URL is user-supplied (JFrog Cloud or self-hosted); v1 doesn't bastion-route JFrog
  jfrog: [],
  // Infisical Cloud US/EU; self-hosted instances use the user's own URL
  infisical: ["app.infisical.com", "us.infisical.com", "eu.infisical.com"],
  // Uptime, Telemetry and organization APIs, plus the regional Telemetry SQL endpoints (<region>-connect.betterstackdata.com).
  "better-stack": [
    "uptime.betterstack.com",
    "incidents.betterstack.com",
    "telemetry.betterstack.com",
    "betterstack.com",
    "*.betterstackdata.com",
  ],
};

/**
 * Trigger an allowlist refresh for the bastion (if connected): call after
 * routes that mutate which accounts reference the bastion.
 */
export async function refreshAllowlistById(bastionId: string): Promise<void> {
  const conn = connections.get(bastionId);
  if (!conn) return;
  await refreshAllowlistFromDb(conn);
}

/**
 * Look up a bastion row by hashed token. Returns `null` for unknown / revoked
 * tokens. Used at WS-connect time to authenticate the agent.
 */
export async function findBastionByHashedToken(
  hashedToken: string,
): Promise<{ id: string; organizationId: string } | null> {
  const [row] = await db
    .select({
      id: bastionVms.id,
      organizationId: bastionVms.organizationId,
      revokedAt: bastionVms.revokedAt,
    })
    .from(bastionVms)
    .where(eq(bastionVms.hashedToken, hashedToken))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  return { id: row.id, organizationId: row.organizationId };
}

/** For tests / shutdown: tear down everything. */
export async function destroyAllAgentConnections(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map((c) => c.destroy()));
}

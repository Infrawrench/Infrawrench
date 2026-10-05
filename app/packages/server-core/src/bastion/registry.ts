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

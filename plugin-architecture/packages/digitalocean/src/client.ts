import type {
  PluginClient,
  ResourceCreateResult,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  ChatMessage,
  ChatStreamEvent,
  ResourceTypeDefinition,
  DashboardStat,
  MetricSeries,
  CredentialExport,
  SizeOption,
  ImageOption,
  HostServices,
  CostFetchRange,
  CostRow,
} from "@infrawrench/plugin-base";
import {
  deleteS3Object,
  getS3BucketPolicy,
  jsonRestFetch,
  labeledFieldItems,
  listS3Objects,
  makeS3Folder,
  putS3BucketPolicy,
  resourceTypeDisplayName,
  renderDnsRecordSidebar,
  signedS3Fetch,
  uploadS3Object,
  virtualHostedUrl,
} from "@infrawrench/plugin-base";
import type { S3StorageConfig, StorageObject } from "@infrawrench/plugin-base";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { SnapshotResourceType } from "./resources/snapshot.js";
import { ImageResourceType } from "./resources/image.js";
import { NfsShareResourceType } from "./resources/nfs-share.js";
import { SPACES_REGIONS } from "./constants.js";
import {
  type DoCreateContext,
  doGetCreateConfig,
  doCreateResource,
  estimateDoDatabaseMonthlyPrice,
} from "./create-handlers.js";
import {
  type ActionContext,
  invokeDropletAction,
  invokeReservedIpAction,
  invokeVolumeAction,
} from "./actions.js";
import {
  applyGenAiModelRouterDetail,
  applyManagedDatabaseDetail,
  applyDatabaseUserDetail,
  applyGenAiAgentDetail,
  applyGenAiKnowledgeBaseDetail,
  applyDropletDetail,
  applyVolumeDetail,
  applySnapshotDetail,
  applyImageDetail,
  applyNfsShareDetail,
  applyReservedIpDetail,
  renderDomainDetail,
  renderDnsRecordDetail,
} from "./detail-renderers.js";
import { fetchDoCostData } from "./cost-data.js";
import { doStatusDot } from "./status-dots.js";
import {
  type DoListerContext,
  listDoResources,
  listSpacesBuckets,
  mapDroplet,
} from "./resource-listers.js";
import { type DoMetricContext, fetchDoMetricSeries } from "./metric-series.js";
import {
  type DoNoSqlContext,
  executeDoNoSqlCommand,
  streamDoChatMessage,
} from "./nosql-console.js";
import { type DoEnrichContext, enrichDoDetail } from "./enrich-detail.js";

/**
 * DO's managed-database `connection.uri` doesn't always carry the credentials
 * inline — MongoDB clusters in particular hand back `mongodb+srv://host/...`
 * with the `user`/`password` exposed only as sibling fields, and feeding that
 * password-less URI to the mongo driver fails with `Password cannot be
 * empty`. Splice the userinfo back in when we have the parts but the URI
 * lacks them. URIs that already include credentials are returned untouched.
 *
 * Done with string manipulation rather than the `URL` class because
 * `mongodb+srv://` is a non-special scheme — the WHATWG URL parser doesn't
 * round-trip the username/password setters on non-special URLs, so a
 * `new URL(...); u.username = ...; u.toString()` no-ops here.
 */
function ensureUriCredentials(
  uri: string,
  user: string | undefined,
  password: string | undefined,
): string {
  if (!uri) return uri;
  if (!user && !password) return uri;
  const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(uri);
  if (!schemeMatch) return uri;
  const scheme = schemeMatch[1]!;
  const remainder = schemeMatch[2]!;
  // Split userinfo off the authority. Only the *last* `@` before the next
  // path/query/fragment terminator separates userinfo from host, because
  // `@` is allowed (percent-encoded) in passwords.
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? "" : remainder.slice(authorityEnd);
  const atIdx = authority.lastIndexOf("@");
  const userinfo = atIdx === -1 ? "" : authority.slice(0, atIdx);
  const host = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  // If the URI already has both halves of userinfo, leave it alone.
  if (userinfo.includes(":") && userinfo.split(":", 2)[1]) return uri;
  const encodedUser = user ? encodeURIComponent(user) : "";
  const encodedPassword = password ? encodeURIComponent(password) : "";
  const newUserinfo = `${encodedUser}:${encodedPassword}`;
  return `${scheme}${newUserinfo}@${host}${tail}`;
}

/** True when `uri` has a non-empty password in its userinfo. */
function uriHasPassword(uri: string): boolean {
  if (!uri) return false;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(uri);
  if (!schemeMatch) return false;
  const remainder = schemeMatch[1]!;
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  const atIdx = authority.lastIndexOf("@");
  if (atIdx === -1) return false;
  const userinfo = authority.slice(0, atIdx);
  const colonIdx = userinfo.indexOf(":");
  return colonIdx !== -1 && userinfo.length > colonIdx + 1;
}

/**
 * DigitalOcean plugin client.
 * Created per account (per API token) by the host.
 * All API calls are made server-side — the token never reaches the browser.
 */
export class DigitalOceanClient implements PluginClient {
  private readonly token: string;
  private readonly credentials: Record<string, string>;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.digitalocean.com/v2";
  /**
   * Cache of bucket name → region populated by `listSpacesBuckets`. Storage
   * verbs only receive the bucket name, but Spaces endpoints are region-
   * specific; consulting the cache avoids a multi-region fan-out per call.
   */
  private readonly spacesBucketRegions = new Map<string, string>();
  /**
   * Short-lived cache of DO resource URN → projectId. The list-by-type host
   * flow calls listResources for every type back-to-back during one refresh
   * cycle; we don't want to rebuild the map for each call. The map's only
   * consumer is `parentResourceIdForUrn`, which always resolves against the
   * latest `/projects/{id}/resources` snapshot inside the TTL window.
   */
  private projectUrnMap: { map: Map<string, string>; expiresAt: number } | null = null;
  /**
   * Catalog caches keyed by the destination prompt-field consumer. Sizes
   * almost never change so a 30-minute TTL is generous; distribution images
   * are also stable. Both are JSON-serialisable into resolvedOutputs so the
   * downstream renderDetail can read them without going async.
   */
  private dropletCatalogCache: {
    sizes?: { value: SizeOption[]; expiresAt: number };
    distributionImages?: { value: ImageOption[]; expiresAt: number };
  } = {};

  private readonly services: HostServices | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("DigitalOcean plugin: missing apiToken credential");
    this.token = token;
    this.credentials = credentials;
    this.resourceTypes = resourceTypes;
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "DO",
        url: `${this.baseUrl}${path}`,
        errorPath: path,
        headers: { Authorization: `Bearer ${this.token}` },
        ...(options ? { init: options } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // DO's generic `{"id":"forbidden","message":"failed to create agent"}`
      // tells the user nothing actionable. Translate the common cause —
      // missing GenAI scopes on the personal access token — into a
      // pointer at the fix. Same root cause for the other gen-ai and
      // dedicated-inference endpoints, so cover both.
      if (
        message.includes("403") &&
        (path.startsWith("/gen-ai/") || path.startsWith("/dedicated-inferences"))
      ) {
        const product = path.startsWith("/dedicated-inferences")
          ? "Dedicated Inference"
          : "Gradient AI";
        throw new Error(
          `${message}\n\n` +
            `Hint: this is almost always the API token's scope. DigitalOcean ` +
            `${product} endpoints need the \`genai:create\` / \`genai:read\` / ` +
            `\`genai:update\` / \`genai:delete\` scopes (and ` +
            `\`dedicated_inference:*\` for Dedicated Inference), which older ` +
            `personal access tokens don't include. Mint a new token at ` +
            `https://cloud.digitalocean.com/account/api/tokens with the GenAI ` +
            `(or "Full Access") scope and update this account's credentials.`,
        );
      }
      throw err;
    }
  }

  /**
   * Build (or return the cached) map of DO resource URN → owning project id.
   * Needed because DO returns project membership via `/projects/{id}/resources`
   * (URNs only), not on the resource itself — and the host filters children by
   * `parentResourceId === project.id`, so without this lookup every droplet /
   * volume / db / etc. would be invisible inside its project's detail page.
   *
   * Cached for 5s so a single refresh cycle (which lists every type
   * back-to-back) pays the cost once. Errors per-project are swallowed so one
   * unreadable project doesn't blank the rest.
   */
  private async getProjectUrnMap(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.projectUrnMap && this.projectUrnMap.expiresAt > now) {
      return this.projectUrnMap.map;
    }
    const map = new Map<string, string>();
    try {
      const projects = await this.fetch<{ projects: Array<{ id: string }> }>("/projects");
      await Promise.all(
        (projects.projects ?? []).map(async (p) => {
          try {
            const data = await this.fetch<{ resources: Array<{ urn: string }> }>(
              `/projects/${p.id}/resources?per_page=200`,
            );
            for (const r of data.resources ?? []) {
              if (r.urn) map.set(r.urn, p.id);
            }
          } catch {
            /* skip projects whose resources we can't list */
          }
        }),
      );
    } catch {
      /* projects API failed entirely — leave the map empty */
    }
    this.projectUrnMap = { map, expiresAt: now + 5000 };
    return map;
  }

  /**
   * Resolve a DO resource URN to the host's full parentResourceId string, or
   * undefined when the resource isn't assigned to any visible project (DO
   * defaults these to the "default" project, but the projects API still maps
   * them; the undefined branch only fires when the cache is cold).
   */
  private parentResourceIdForUrn(
    accountId: string,
    urn: string,
    map: Map<string, string>,
  ): string | undefined {
    const projectId = map.get(urn);
    return projectId ? `${accountId}:project:${projectId}` : undefined;
  }

  /** The slice of this client the resource listers need. */
  private get listerCtx(): DoListerContext {
    return {
      token: this.token,
      credentials: this.credentials,
      fetch: this.fetch.bind(this),
      getProjectUrnMap: this.getProjectUrnMap.bind(this),
      parentResourceIdForUrn: this.parentResourceIdForUrn.bind(this),
      spacesBucketRegions: this.spacesBucketRegions,
    };
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    return listDoResources(this.listerCtx, typeId, accountId);
  }
  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    // Prefer the single-resource endpoint where DO exposes one — it avoids a
    // race against /v2/droplets right after a POST create returns (the list
    // endpoint can take a few seconds to reflect a brand-new droplet, which
    // surfaced as "resource not found" on the post-create navigation).
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "droplet" && externalId) {
      try {
        const [data, projectMap] = await Promise.all([
          this.fetch<{ droplet: Record<string, unknown> }>(`/droplets/${externalId}`),
          this.getProjectUrnMap(),
        ]);
        return mapDroplet(this.listerCtx, data.droplet, accountId, projectMap);
      } catch (error) {
        // Only fall through to the list-and-find path when the single endpoint
        // reports the droplet missing (the list cache can still carry it
        // briefly). Transient failures — 429 rate limits especially — must
        // propagate: the list call costs far more against the same limit.
        const message = error instanceof Error ? error.message : String(error);
        if (!/\bAPI error 404\b/.test(message)) throw error;
      }
    }
    // Spaces buckets aren't exposed via the REST API, and a freshly-created
    // bucket can be missing from `listSpacesBuckets` for tens of seconds
    // while regional S3 endpoints converge on the new key/bucket — which
    // surfaced as a post-create 404 on the bucket detail page. HEAD the
    // bucket directly via the S3 virtual-hosted endpoint instead; iterate
    // the known Spaces regions and accept the first 200. This is cheap (no
    // body), and `spacesBucketRegions` caches the resolved region so
    // subsequent calls don't fan out.
    if (typeId === "spaces-bucket" && externalId) {
      const accessKeyId = this.credentials["spacesAccessKeyId"];
      const secretAccessKey = this.credentials["spacesSecretAccessKey"];
      if (accessKeyId && secretAccessKey) {
        const cachedRegion = this.spacesBucketRegions.get(externalId);
        const regionsToProbe = cachedRegion
          ? [cachedRegion, ...SPACES_REGIONS.filter((r) => r !== cachedRegion)]
          : SPACES_REGIONS;
        for (const region of regionsToProbe) {
          const url = `https://${externalId}.${region}.digitaloceanspaces.com/`;
          const res = await signedS3Fetch({
            accessKey: accessKeyId,
            secretKey: secretAccessKey,
            region,
            method: "HEAD",
            url,
          }).catch(() => null);
          if (res && res.ok) {
            this.spacesBucketRegions.set(externalId, region);
            const projectMap = await this.getProjectUrnMap();
            const parentResourceId = this.parentResourceIdForUrn(
              accountId,
              `do:space:${externalId}`,
              projectMap,
            );
            return {
              id: `${accountId}:spaces-bucket:${externalId}`,
              pluginId: "digitalocean",
              resourceTypeId: "spaces-bucket",
              accountId,
              displayName: externalId,
              fields: { name: externalId, region, accessControl: "private" },
              resolvedOutputs: {
                endpoint: `https://${externalId}.${region}.digitaloceanspaces.com`,
              },
              secretStates: [],
              externalId,
              ...(parentResourceId ? { parentResourceId } : {}),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          }
        }
      }
      // Fall through — listResources may have a different cached state.
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`DigitalOcean plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    // resolveOutput receives the full `{accountId}:{typeId}:{externalId}`
    // resource id from the host. DO's REST endpoints take the bare external
    // id (the cluster/database UUID), so peel the prefix off before
    // interpolating — passing the full id produced
    // `/kubernetes/clusters/{accountId}:doks-cluster:{uuid}/kubeconfig`,
    // which 404s as "cluster not found".
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "doks-cluster" && outputKey === "kubeconfig") {
      // The kubeconfig endpoint returns raw `application/yaml` text, not a
      // JSON envelope (verified in digitalocean/openapi
      // resources/kubernetes/responses/kubeconfig.yml). Bypass
      // jsonRestFetch and read the body as text directly.
      const res = await fetch(`${this.baseUrl}/kubernetes/clusters/${externalId}/kubeconfig`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/yaml" },
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(
          `DO API error ${res.status} for /kubernetes/clusters/${externalId}/kubeconfig: ${body}`,
        );
      }
      return body;
    }

    if (typeId === "managed-database") {
      const data = await this.fetch<{
        database: {
          engine?: string;
          connection: Record<string, string>;
          private_connection?: Record<string, string>;
        };
      }>(`/databases/${externalId}`);
      const conn = data.database.connection;
      const engine = String(data.database.engine ?? "");
      switch (outputKey) {
        case "connectionString": {
          // Kafka connects over SASL/SCRAM-SHA-256. DO's Kafka connection block
          // leaves `uri` EMPTY (multi-listener cluster) and only fills
          // `host`/`port`, so we build the bootstrap from those. That port is
          // the SASL_SSL listener; SSL/mTLS is on a separate port DO doesn't
          // expose via the API, so a client cert alone can't connect here. SASL
          // needs the minted user's password, which DO only returns when the
          // token carries `database:view_credentials`.
          if (engine === "kafka") {
            const host = conn["host"] ?? "";
            const port = conn["port"] ?? "";
            const authority = host && port ? `${host}:${port}` : host;
            if (!authority) {
              throw new Error(
                "DigitalOcean returned no broker endpoint (host/port) for this Kafka cluster.",
              );
            }
            const minted = await this.findMintedDatabaseUser(externalId, accountId);
            const user = minted?.password ? minted.name : (conn["user"] ?? "");
            const password = minted?.password || conn["password"] || "";
            if (user && password) {
              // DO signs broker certs with its own CA, so pass it along (base64
              // in `ssl_ca`) for the driver to verify against — otherwise the
              // TLS handshake fails with "self signed certificate in chain".
              const ca = await this.resolveCaCertificate(externalId).catch(() => "");
              const params = new URLSearchParams({ sasl: "scram-sha-256", ssl: "true" });
              if (ca) params.set("ssl_ca", btoa(ca));
              return `kafka://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${authority}?${params.toString()}`;
            }
            // We may have captured the user's mTLS cert/key, but without the
            // SASL password there's nothing usable on this (SASL_SSL) port.
            const hadCertOnly = !!(minted?.accessCert && minted?.accessKey);
            throw new Error(
              hadCertOnly
                ? "This Kafka user was created with an mTLS certificate but no SASL password, so " +
                    "Infrawrench can't connect — DigitalOcean serves mTLS on a separate port it " +
                    "doesn't expose via the API. Regenerate your DO API token with the " +
                    "`database:view_credentials` scope ticked (it's NOT in “Full Access” by default), " +
                    "then click “Make connection user” again so DO returns the SASL password."
                : "DigitalOcean doesn't expose a password for this Kafka cluster. Click “Make " +
                    "connection user” on the cluster detail page — with the `database:view_credentials` " +
                    "token scope, Infrawrench captures the SASL password and the connection works.",
            );
          }
          let uri = ensureUriCredentials(conn["uri"] ?? "", conn["user"], conn["password"]);
          // Postgres/MySQL hand the password back inline on the cluster (or on
          // the default user via /users) — for those we capture it directly.
          // Mongo/Redis/OpenSearch/Kafka never expose the default user's
          // password this way, so we DON'T poke /users for them (it just
          // produces noise + confusing scope errors); they rely entirely on a
          // user minted through the "Make connection user" button, whose
          // credential we persisted ourselves.
          const captureFromDefault = engine === "pg" || engine === "mysql";
          if (captureFromDefault && !uriHasPassword(uri) && conn["user"]) {
            try {
              const usersData = await this.fetch<{
                users?: Array<{ name?: string; password?: string }>;
              }>(`/databases/${externalId}/users`);
              const list = usersData.users ?? [];
              const match = list.find((u) => u.name === conn["user"]);
              if (match?.password) {
                uri = ensureUriCredentials(conn["uri"] ?? "", conn["user"], match.password);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(
                "DigitalOcean's `/databases/{id}/users` endpoint failed — this usually means " +
                  "the API token lacks the `database:view_credentials` scope. In the DO token UI, " +
                  "regenerate the token and explicitly tick that scope (it's *not* included by " +
                  `default in "Full Access"). Underlying error: ${msg}`,
              );
            }
          }
          // Use a user we minted ourselves (via "Make connection user" or the
          // DB Users section) and persisted via the secret store. This is the
          // primary path for mongo/redis/opensearch/kafka and a fallback for
          // pg/mysql when DO won't re-expose the default user's password.
          if (!uriHasPassword(uri)) {
            const minted = await this.findMintedDatabaseUser(externalId, accountId);
            if (minted) {
              uri = ensureUriCredentials(conn["uri"] ?? "", minted.name, minted.password);
            }
          }
          if (!uriHasPassword(uri)) {
            throw new Error(
              captureFromDefault
                ? "DigitalOcean returned no password for this database's default user. Use the " +
                    "“Make connection user” button on the cluster detail page (or the DB Users " +
                    "section) and Infrawrench will capture and store the credential."
                : `DigitalOcean doesn't expose a password for ${engine} clusters' default user. ` +
                    "Click “Make connection user” on the cluster detail page — Infrawrench creates a " +
                    "user, captures the credential DO mints once, and stores it for this connection.",
            );
          }
          return uri;
        }
        case "host":
          return conn["host"] ?? "";
        case "port":
          return conn["port"] ?? "";
        case "username":
          return conn["user"] ?? "";
        case "password":
          return conn["password"] ?? "";
        case "database":
          return conn["database"] ?? "";
        case "caCertificate":
          return this.resolveCaCertificate(externalId);
      }
    }

    if (typeId === "spaces-bucket") {
      // Spaces credentials are account-level (from the Spaces API keys), not bucket-specific
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        const region = String(resource.fields["region"] ?? "nyc3");
        return `https://${region}.digitaloceanspaces.com`;
      }
      if (outputKey === "accessKeyId") return this.credentials["spacesAccessKeyId"] ?? "";
      if (outputKey === "secretAccessKey") return this.credentials["spacesSecretAccessKey"] ?? "";
    }

    if (typeId === "container-registry") {
      // externalId is the registry name — the endpoint/serverUrl outputs are
      // pure string builds, no API call needed.
      if (outputKey === "endpoint") return `registry.digitalocean.com/${externalId}`;
      if (outputKey === "serverUrl") return "registry.digitalocean.com";
      if (
        outputKey === "dockerConfigJson" ||
        outputKey === "username" ||
        outputKey === "password"
      ) {
        // GET /v2/registry/docker-credentials returns a .dockerconfigjson
        // document verbatim — `{ auths: { "registry.digitalocean.com":
        // { auth: base64("user:pass") } } }`, no DO envelope around it.
        // `read_write=true` asks for push+pull credentials (the default is
        // read-only).
        const doc = await this.fetch<{ auths?: Record<string, { auth?: string }> }>(
          "/registry/docker-credentials?read_write=true",
        );
        if (outputKey === "dockerConfigJson") return JSON.stringify(doc);
        const auth = doc.auths?.["registry.digitalocean.com"]?.auth ?? "";
        if (!auth) {
          throw new Error("DigitalOcean returned no docker credentials for the registry.");
        }
        // base64 → "user:pass". Split on the FIRST colon — DO uses the API
        // token for both halves today, but only the username is guaranteed
        // colon-free.
        const decoded = atob(auth);
        const sep = decoded.indexOf(":");
        if (sep === -1) {
          throw new Error("DigitalOcean returned malformed docker credentials (no user:pass).");
        }
        return outputKey === "username" ? decoded.slice(0, sep) : decoded.slice(sep + 1);
      }
    }

    if (typeId === "vpc" && outputKey === "vpcId") {
      // The VPC uuid is the externalId — no API call needed.
      return externalId;
    }

    if (typeId === "domain" && outputKey === "nameservers") {
      return "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com";
    }

    if (typeId === "db-user" && outputKey === "password") {
      // We never look the password up from DO — it's only available the
      // instant the user was created. The plaintext lives in our local
      // secret store, keyed by the resource id.
      const value = await this.services?.secrets?.getPlaintext(resourceId, "password");
      if (!value) {
        throw new Error(
          "No stored password for this user. Passwords are only captured at create time; " +
            "DigitalOcean doesn't expose existing user passwords after the fact.",
        );
      }
      return value;
    }

    throw new Error(
      `DigitalOcean plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  /**
   * Look through every db-user we've persisted for the given cluster and
   * return the first one with a stored credential. Used by managed-database's
   * `connectionString` resolver when DO refuses to hand back the original
   * doadmin credentials. The cluster's user list is fetched live (we don't
   * trust local cache for membership) but the secrets come from the host's
   * store via `services.secrets.getPlaintext`. For Kafka we also surface the
   * mTLS `accessCert`/`accessKey`, since DO returns those even when the SASL
   * password is gated behind `database:view_credentials`.
   */
  private async findMintedDatabaseUser(
    clusterId: string,
    accountId: string,
  ): Promise<{
    name: string;
    password: string;
    accessCert?: string;
    accessKey?: string;
  } | null> {
    const secrets = this.services?.secrets;
    if (!secrets) return null;
    let users: Array<{ name?: string }> = [];
    try {
      const resp = await this.fetch<{ users?: Array<{ name?: string }> }>(
        `/databases/${clusterId}/users`,
      );
      users = resp.users ?? [];
    } catch {
      return null;
    }
    for (const u of users) {
      if (!u.name) continue;
      const id = `${accountId}:db-user:${clusterId}:${u.name}`;
      const [password, accessCert, accessKey] = await Promise.all([
        secrets.getPlaintext(id, "password"),
        secrets.getPlaintext(id, "accessCert"),
        secrets.getPlaintext(id, "accessKey"),
      ]);
      if (password || (accessCert && accessKey)) {
        return {
          name: u.name,
          password: password ?? "",
          ...(accessCert ? { accessCert } : {}),
          ...(accessKey ? { accessKey } : {}),
        };
      }
    }
    return null;
  }

  /**
   * Fetch + decode a managed-database cluster's CA certificate. DO returns it
   * base64-encoded (openapi `format: byte`); we hand back raw PEM so TLS layers
   * (pg, mysql2, kafkajs) can parse it. Shared by the `caCertificate` output
   * and the Kafka mTLS connection-string builder.
   */
  private async resolveCaCertificate(clusterId: string): Promise<string> {
    const caData = await this.fetch<{ ca: { certificate: string } }>(`/databases/${clusterId}/ca`);
    const raw = caData.ca.certificate ?? "";
    // Already PEM? Pass through. Otherwise base64 → utf8. `atob` is the
    // cross-runtime decoder (Node ≥18 + browser); we can't import `Buffer`
    // here because this plugin is shared with the renderer.
    if (raw.includes("-----BEGIN")) return raw;
    try {
      return atob(raw);
    } catch {
      return raw;
    }
  }

  private get createCtx(): DoCreateContext {
    return {
      fetch: this.fetch.bind(this),
      credentials: this.credentials,
    };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchDoCostData({ fetch: this.fetch.bind(this) }, range);
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return doGetCreateConfig(this.createCtx, typeId, parentResourceId);
  }

  /**
   * Compute the form's estimated monthly cost. The size-picker only carries
   * the per-node price; the cost panel needs to multiply by node count for
   * resource types that scale horizontally (managed-database, doks-cluster).
   * Droplet has its own per-size price already shown in the picker; for it
   * we return the picked size's price directly so the panel matches.
   */
  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    if (typeId === "managed-database") {
      const slug = fields["size"] ?? "";
      const memMatch = /(\d+)gb/i.exec(slug);
      const memoryGb = memMatch ? Number(memMatch[1]) : 0;
      const perNode = estimateDoDatabaseMonthlyPrice(slug, memoryGb);
      const nodes = Math.max(1, Number(fields["nodeCount"] ?? 1));
      return perNode > 0 ? perNode * nodes : null;
    }
    if (typeId === "doks-cluster") {
      // Cluster control plane is free; cost is node count × droplet size price.
      // We don't have a size price lookup for DOKS sizes here — defer to the
      // sidebar's picker price which the host already shows.
      return null;
    }
    return null;
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "spaces-bucket") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const bucketName = String(resource.fields["name"] ?? resource.externalId ?? "");
      const region = String(resource.fields["region"] ?? "nyc3");
      if (!bucketName) throw new Error("Cannot determine Spaces bucket name");
      const permission =
        formatId === "bucket-scoped-ro"
          ? "read"
          : formatId === "bucket-scoped-rw"
            ? "readwrite"
            : "";
      if (!permission) {
        throw new Error(`DigitalOcean plugin: unknown spaces key format "${formatId}"`);
      }
      const name = `infrawrench-${bucketName}-${Date.now().toString(36)}`;
      const resp = await this.fetch<{
        key?: { name: string; access_key: string; secret_key?: string };
      }>("/spaces/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          grants: [{ bucket: bucketName, permission }],
        }),
      });
      const key = resp.key;
      const accessKeyId = key?.access_key ?? "";
      const secret = key?.secret_key ?? "";
      if (!accessKeyId || !secret) {
        throw new Error("DigitalOcean returned an empty Spaces key");
      }
      const endpoint = `https://${region}.digitaloceanspaces.com`;
      const ini =
        `[default]\n` +
        `aws_access_key_id=${accessKeyId}\n` +
        `aws_secret_access_key=${secret}\n` +
        `# endpoint=${endpoint}\n` +
        `# bucket=${bucketName}\n` +
        `# permission=${permission}\n`;
      return {
        content: ini,
        filename: `${bucketName}.credentials`,
        mimeType: "text/plain",
        fields: [
          { label: "Access Key ID", value: accessKeyId },
          { label: "Secret Access Key", value: secret, sensitive: true, hint: "Only shown once" },
          { label: "Endpoint", value: endpoint },
          { label: "Bucket", value: bucketName },
          { label: "Permission", value: permission },
        ],
        warning:
          "Save this now. The secret key cannot be re-fetched from the DigitalOcean API. This key is scoped to a single bucket — delete it from the DO console when no longer needed.",
      };
    }
    throw new Error(
      `DigitalOcean plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse resource ID");

    switch (typeId) {
      case "droplet":
        await this.fetch<unknown>(`/droplets/${externalId}`, { method: "DELETE" });
        break;
      case "doks-cluster":
        await this.fetch<unknown>(`/kubernetes/clusters/${externalId}`, { method: "DELETE" });
        break;
      case "managed-database":
        await this.fetch<unknown>(`/databases/${externalId}`, { method: "DELETE" });
        break;
      case "db-user": {
        // Composite id: `{accountId}:db-user:{clusterId}:{username}`. The
        // parent cluster id is the second-to-last segment, the username the
        // last. We can't reuse `externalId.split(":").pop()` alone because the
        // delete endpoint needs both.
        const parts = resourceId.split(":");
        const username = parts[parts.length - 1] ?? "";
        const clusterId = parts[parts.length - 2] ?? "";
        if (!username || !clusterId) {
          throw new Error("Cannot parse db-user resource ID");
        }
        await this.fetch<unknown>(`/databases/${clusterId}/users/${encodeURIComponent(username)}`, {
          method: "DELETE",
        });
        break;
      }
      case "spaces-bucket": {
        // Spaces are managed via the S3-compatible API, not the DO REST API.
        const accessKeyId = this.credentials["spacesAccessKeyId"];
        const secretAccessKey = this.credentials["spacesSecretAccessKey"];
        if (!accessKeyId || !secretAccessKey) {
          throw new Error(
            "DigitalOcean plugin: Spaces management requires S3-compatible credentials " +
              '("spacesAccessKeyId" and "spacesSecretAccessKey"). ' +
              "Generate these in the DigitalOcean console under API > Spaces Keys.",
          );
        }
        // We need the region to build the endpoint. Try to look it up from the resource,
        // but fall back to parsing the externalId (which is the bucket name).
        const bucketName = externalId;
        let bucketRegion = "nyc3";
        try {
          const resource = await this.getResource("spaces-bucket", resourceId, _accountId);
          bucketRegion = String(resource.fields["region"] ?? "nyc3");
        } catch {
          // Fall back to default region
        }
        const deleteHost = `${bucketName}.${bucketRegion}.digitaloceanspaces.com`;
        const delRes = await signedS3Fetch({
          accessKey: accessKeyId,
          secretKey: secretAccessKey,
          region: bucketRegion,
          method: "DELETE",
          url: `https://${deleteHost}/`,
        });
        if (!delRes.ok) {
          throw new Error(
            `Spaces S3 API error ${delRes.status} deleting bucket "${bucketName}": ${await delRes.text()}`,
          );
        }
        break;
      }
      case "container-registry": {
        // DELETE /v2/registry takes no id — it deletes THE account's
        // registry, whatever it's called. Guard against a stale resource id
        // pointing at a registry that has since been replaced: verify the
        // current registry is the one being asked about before firing.
        const data = await this.fetch<{ registry?: { name?: string } }>("/registry");
        const currentName = data.registry?.name ?? "";
        if (currentName !== externalId) {
          throw new Error(
            `DigitalOcean plugin: the account's registry is "${currentName}", not ` +
              `"${externalId}" — refusing to delete it.`,
          );
        }
        await this.fetch<unknown>("/registry", { method: "DELETE" });
        break;
      }
      case "domain":
        await this.fetch<unknown>(`/domains/${externalId}`, { method: "DELETE" });
        break;
      case "dns-record": {
        // externalId format: "{domainName}/{recordId}"
        const parts = externalId.split("/");
        const domainName = parts[0]!;
        const recordId = parts[1]!;
        await this.fetch<unknown>(`/domains/${domainName}/records/${recordId}`, {
          method: "DELETE",
        });
        break;
      }
      case "project":
        await this.fetch<unknown>(`/projects/${externalId}`, { method: "DELETE" });
        break;
      case "vpc":
        // DO refuses (403) when the VPC is a region's default or still has
        // member resources; that error surfaces to the user verbatim.
        await this.fetch<unknown>(`/vpcs/${externalId}`, { method: "DELETE" });
        break;
      case "volume":
        await this.fetch<unknown>(`/volumes/${externalId}`, { method: "DELETE" });
        break;
      case "reserved-ip":
        // The address itself is the id. DELETE releases it back to the pool —
        // irreversible, you don't get the same address again. DO returns 422
        // while the IP is still assigned to a Droplet; that message surfaces
        // to the user verbatim, which reads better than pre-unassigning
        // behind their back.
        await this.fetch<unknown>(`/reserved_ips/${externalId}`, { method: "DELETE" });
        break;
      case "snapshot":
        // /v2/snapshots/{id} covers both droplet and volume snapshots — DO
        // uses the same endpoint family regardless of source type.
        await this.fetch<unknown>(`/snapshots/${externalId}`, { method: "DELETE" });
        break;
      case "image":
        // Only user-owned images (snapshots/backups/custom uploads) are
        // deletable — DO returns 403 for distribution images, surfaced as a
        // host-level error.
        await this.fetch<unknown>(`/images/${externalId}`, { method: "DELETE" });
        break;
      case "nfs-share": {
        // externalId format: "{region}/{shareId}" — the API endpoint takes
        // a `region` query param alongside the bare share id.
        const parts = externalId.split("/");
        const region = parts[0]!;
        const shareId = parts[1]!;
        await this.fetch<unknown>(`/nfs/${shareId}?region=${encodeURIComponent(region)}`, {
          method: "DELETE",
        });
        break;
      }
      case "gen-ai-agent":
        await this.fetch<unknown>(`/gen-ai/agents/${externalId}`, { method: "DELETE" });
        break;
      case "gen-ai-knowledge-base":
        await this.fetch<unknown>(`/gen-ai/knowledge_bases/${externalId}`, { method: "DELETE" });
        break;
      case "gen-ai-model-router":
        await this.fetch<unknown>(`/gen-ai/models/routers/${externalId}`, { method: "DELETE" });
        break;
      case "dedicated-inference":
        await this.fetch<unknown>(`/dedicated-inferences/${externalId}`, { method: "DELETE" });
        break;
      case "inference-batch": {
        // Batch jobs are cancelled rather than deleted. The endpoint lives
        // on the data-plane host, so bypass `this.fetch` (which targets
        // api.digitalocean.com) and call it directly with the same bearer.
        const res = await fetch(`https://inference.do-ai.run/v1/batches/${externalId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok && res.status !== 404) {
          throw new Error(`DO API error ${res.status} cancelling batch ${externalId}`);
        }
        break;
      }
      case "model-api-key":
        await this.fetch<unknown>(`/gen-ai/models/api_keys/${externalId}`, { method: "DELETE" });
        break;
      case "agent-api-key": {
        // Composite externalId `{agentUuid}/{keyUuid}` — both halves are
        // required because DO scopes the endpoint to the parent agent.
        const parts = externalId.split("/");
        const agentUuid = parts[0]!;
        const keyUuid = parts[1]!;
        await this.fetch<unknown>(`/gen-ai/agents/${agentUuid}/api_keys/${keyUuid}`, {
          method: "DELETE",
        });
        break;
      }
      default:
        throw new Error(`DigitalOcean plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").pop() ?? "";

    if (typeId === "gen-ai-agent") {
      // DO's PUT /v2/gen-ai/agents/{uuid} accepts only the fields supplied —
      // map the editable resource fields to the API's snake_case keys. A
      // `model_uuid`/`model_router_uuid` change is the swap-router flow: if
      // both are touched in the same edit, the explicit user intent is to
      // pick whichever side has a non-empty value (router wins ties, since
      // setting a router supersedes the model).
      const fieldMap: Record<string, string> = {
        name: "name",
        description: "description",
        instruction: "instruction",
        temperature: "temperature",
        maxTokens: "max_tokens",
        k: "k",
      };
      const body: Record<string, unknown> = {};
      for (const [src, dst] of Object.entries(fieldMap)) {
        if (fields[src] !== undefined) body[dst] = fields[src];
      }
      // temperature / max_tokens / k are typed `string` in the host diff but
      // the API wants numbers — coerce, dropping empty strings.
      for (const key of ["temperature", "max_tokens", "k"] as const) {
        if (body[key] !== undefined) {
          const n = Number(body[key]);
          if (Number.isFinite(n)) body[key] = n;
          else delete body[key];
        }
      }
      // Swap between a model and a router. `model_uuid` and
      // `model_router_uuid` are mutually exclusive in DO's API — picking a
      // router moves model_uuid to "" and vice versa. If only one side
      // changed, send only that side; if both, prefer router when set.
      const routerTouched = fields["modelRouterUuid"] !== undefined;
      const modelTouched = fields["modelUuid"] !== undefined;
      if (routerTouched && fields["modelRouterUuid"]) {
        body["model_router_uuid"] = fields["modelRouterUuid"];
      } else if (modelTouched && fields["modelUuid"]) {
        body["model_uuid"] = fields["modelUuid"];
      } else if (routerTouched && !fields["modelRouterUuid"] && fields["modelUuid"]) {
        // Router was cleared but a model UUID is still present — switch back
        // to the single-model path explicitly.
        body["model_uuid"] = fields["modelUuid"];
      }
      const data = await this.fetch<{ agent: Record<string, unknown> }>(
        `/gen-ai/agents/${externalId}`,
        {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      const a = data.agent ?? {};
      const uuid = String(a["uuid"] ?? externalId);
      const model = a["model"] as Record<string, unknown> | undefined;
      const router = a["model_router"] as Record<string, unknown> | undefined;
      const deployment = a["deployment"] as Record<string, unknown> | undefined;
      const deploymentUrl = String(deployment?.["url"] ?? "");
      const knowledgeBases = Array.isArray(a["knowledge_bases"])
        ? (a["knowledge_bases"] as unknown[])
        : [];
      return {
        id: `${accountId}:gen-ai-agent:${uuid}`,
        pluginId: "digitalocean",
        resourceTypeId: "gen-ai-agent",
        accountId,
        displayName: String(a["name"] ?? uuid),
        fields: {
          name: String(a["name"] ?? ""),
          region: String(a["region"] ?? ""),
          description: String(a["description"] ?? ""),
          instruction: String(a["instruction"] ?? ""),
          modelUuid: String(model?.["uuid"] ?? ""),
          modelName: String(model?.["name"] ?? ""),
          modelRouterUuid: String(router?.["uuid"] ?? ""),
          modelRouterName: String(router?.["name"] ?? ""),
          projectId: String(a["project_id"] ?? ""),
          temperature: Number(a["temperature"] ?? 0),
          maxTokens: Number(a["max_tokens"] ?? 0),
          k: Number(a["k"] ?? 0),
          status: String(deployment?.["status"] ?? a["status"] ?? ""),
          deploymentVisibility: String(deployment?.["visibility"] ?? ""),
          knowledgeBaseCount: knowledgeBases.length,
          deploymentUrl,
        },
        resolvedOutputs: deploymentUrl ? { deploymentUrl, agentEndpoint: deploymentUrl } : {},
        secretStates: [],
        externalId: uuid,
        createdAt: String(a["created_at"] ?? new Date().toISOString()),
        updatedAt: String(a["updated_at"] ?? new Date().toISOString()),
      };
    }

    if (typeId === "gen-ai-knowledge-base") {
      // PUT /v2/gen-ai/knowledge_bases/{uuid} accepts only name, tags,
      // project_id, and database_id — region + embedding model are immutable
      // (they're locked `editable: false` on the resource type). `tags` is a
      // comma-separated string in the host diff; split it into the API's array.
      const body: Record<string, unknown> = { uuid: externalId };
      if (fields["name"] !== undefined) body["name"] = fields["name"];
      if (fields["projectId"] !== undefined) body["project_id"] = fields["projectId"];
      if (fields["databaseId"] !== undefined) body["database_id"] = fields["databaseId"];
      if (fields["tags"] !== undefined) {
        body["tags"] = fields["tags"]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      const data = await this.fetch<{ knowledge_base: Record<string, unknown> }>(
        `/gen-ai/knowledge_bases/${externalId}`,
        {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      const kb = data.knowledge_base ?? {};
      const uuid = String(kb["uuid"] ?? externalId);
      const lastJob = kb["last_indexing_job"] as Record<string, unknown> | undefined;
      const tags = Array.isArray(kb["tags"]) ? (kb["tags"] as string[]) : [];
      const dataSources = Array.isArray(kb["data_sources"])
        ? (kb["data_sources"] as unknown[]).length
        : 0;
      return {
        id: `${accountId}:gen-ai-knowledge-base:${uuid}`,
        pluginId: "digitalocean",
        resourceTypeId: "gen-ai-knowledge-base",
        accountId,
        displayName: String(kb["name"] ?? uuid),
        fields: {
          name: String(kb["name"] ?? ""),
          region: String(kb["region"] ?? ""),
          embeddingModelUuid: String(kb["embedding_model_uuid"] ?? ""),
          databaseId: String(kb["database_id"] ?? ""),
          projectId: String(kb["project_id"] ?? ""),
          isPublic: kb["is_public"] ? "yes" : "no",
          lastIndexingStatus: String(lastJob?.["status"] ?? ""),
          dataSourceCount: dataSources,
          tags: tags.join(","),
        },
        resolvedOutputs: uuid
          ? { retrievalEndpoint: `https://kbaas.do-ai.run/v1/${uuid}/retrieve` }
          : {},
        secretStates: [],
        externalId: uuid,
        createdAt: String(kb["created_at"] ?? new Date().toISOString()),
        updatedAt: String(kb["updated_at"] ?? new Date().toISOString()),
      };
    }

    if (typeId === "dns-record") {
      // externalId format: "{domainName}/{recordId}"
      const parts = externalId.split("/");
      const domainName = parts[0]!;
      const recordId = parts[1]!;
      const body: Record<string, unknown> = {};
      if (fields["type"] !== undefined) body["type"] = fields["type"];
      if (fields["name"] !== undefined) body["name"] = fields["name"];
      if (fields["data"] !== undefined) body["data"] = fields["data"];
      if (fields["ttl"] !== undefined && fields["ttl"] !== "") body["ttl"] = Number(fields["ttl"]);
      if (fields["priority"] !== undefined && fields["priority"] !== "")
        body["priority"] = Number(fields["priority"]);
      const data = await this.fetch<{ domain_record: Record<string, unknown> }>(
        `/domains/${domainName}/records/${recordId}`,
        {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      const r = data.domain_record ?? {};
      const type = String(r["type"] ?? fields["type"] ?? "");
      const name = String(r["name"] ?? "@");
      const displayName = name === "@" ? domainName : `${name}.${domainName}`;
      return {
        id: resourceId,
        pluginId: "digitalocean",
        resourceTypeId: "dns-record",
        accountId,
        displayName: `${type} ${displayName}`,
        fields: {
          type,
          name: displayName,
          data: String(r["data"] ?? fields["data"] ?? ""),
          ttl: Number(r["ttl"] ?? 1800),
          ...(r["priority"] !== undefined && r["priority"] !== null
            ? { priority: Number(r["priority"]) }
            : {}),
          domainName,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId,
        parentResourceId: `${accountId}:domain:${domainName}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    if (typeId === "droplet") {
      // Rename and/or resize. Resize is DO's `resize` droplet action with
      // `disk: false` — CPU/RAM only, reversible, and DO powers the Droplet
      // off for it automatically. DO rejects targets whose included disk is
      // smaller than the Droplet's current disk; that error surfaces as-is.
      //
      // The two actions are independent: one failing must not silently skip
      // or hide the other, so each runs in its own guard and the failures are
      // combined into one labelled error that makes partial success explicit.
      const failures: string[] = [];
      const name = fields["name"];
      if (name !== undefined && name !== "") {
        try {
          await this.fetch<unknown>(`/droplets/${externalId}/actions`, {
            method: "POST",
            body: JSON.stringify({ type: "rename", name }),
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          failures.push(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const size = fields["size"];
      if (size !== undefined && size !== "") {
        try {
          await this.fetch<unknown>(`/droplets/${externalId}/actions`, {
            method: "POST",
            body: JSON.stringify({ type: "resize", size, disk: false }),
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          failures.push(`resize failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`DigitalOcean droplet update: ${failures.join("; ")}`);
      }
      // Both actions are asynchronous on DO's side — an immediate re-read can
      // still report the old name/size while the action runs. Overlay the
      // accepted values so the returned resource reflects the requested end
      // state (the sleep/wake "don't fight the sync" stance); the next sync
      // reads the converged truth.
      const refreshed = await this.getResource(typeId, resourceId, accountId);
      return {
        ...refreshed,
        fields: {
          ...refreshed.fields,
          ...(name !== undefined && name !== "" ? { name } : {}),
          ...(size !== undefined && size !== "" ? { size } : {}),
        },
        ...(name !== undefined && name !== "" ? { displayName: name } : {}),
        updatedAt: new Date().toISOString(),
      };
    }

    if (typeId !== "project") {
      throw new Error(`DigitalOcean plugin: updateResource not supported for type "${typeId}"`);
    }
    // DO's PATCH /v2/projects/{id} accepts only the fields supplied — name,
    // description, purpose, environment. Send through whatever the caller
    // changed; the host has already diffed against the prior values.
    const body: Record<string, string> = {};
    for (const key of ["name", "description", "purpose", "environment"] as const) {
      if (fields[key] !== undefined) body[key] = fields[key];
    }
    const data = await this.fetch<{ project: Record<string, unknown> }>(`/projects/${externalId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const p = data.project;
    return {
      id: `${accountId}:project:${String(p["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "project",
      accountId,
      displayName: String(p["name"]),
      fields: {
        name: String(p["name"]),
        purpose: String(p["purpose"] ?? ""),
        description: String(p["description"] ?? ""),
        environment: String(p["environment"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(p["id"]),
      createdAt: String(p["created_at"] ?? new Date().toISOString()),
      updatedAt: String(p["updated_at"] ?? new Date().toISOString()),
    };
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "volume" && targetTypeId === "droplet") {
      const [volume, droplet] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeRegion = String(volume.fields["region"] ?? "");
      const dropletRegion = String(droplet.fields["region"] ?? "");
      if (volumeRegion && dropletRegion && volumeRegion !== dropletRegion) {
        throw new Error(
          `Volume region ${volumeRegion} does not match droplet region ${dropletRegion} — DigitalOcean volumes must be in the same region as the droplet.`,
        );
      }
      const volumeId = volume.externalId ?? sourceResourceId.split(":").pop();
      const dropletId = Number(droplet.externalId ?? targetResourceId.split(":").pop());
      if (!volumeId || !Number.isFinite(dropletId)) {
        throw new Error("Cannot determine volume or droplet id for attachment");
      }
      await this.fetch(`/volumes/${volumeId}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "attach", droplet_id: dropletId, region: volumeRegion }),
      });
      return;
    }
    if (sourceTypeId === "reserved-ip" && targetTypeId === "droplet") {
      // Drag a reserved IP onto a Droplet to assign it. The type declares
      // `matchField: "region"` so the host already rejects cross-region drops,
      // but re-check here: `attachResource` is also reachable from the API and
      // DO's own error for this ("Droplet is not in the same region") gives no
      // hint about which side is wrong.
      const [reservedIp, droplet] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const ipRegion = String(reservedIp.fields["region"] ?? "");
      const dropletRegion = String(droplet.fields["region"] ?? "");
      if (ipRegion && dropletRegion && ipRegion !== dropletRegion) {
        throw new Error(
          `Reserved IP region ${ipRegion} does not match droplet region ${dropletRegion} — DigitalOcean reserved IPs can only be assigned to Droplets in the region they are reserved to.`,
        );
      }
      const ip = reservedIp.externalId ?? sourceResourceId.split(":").pop();
      const dropletId = Number(droplet.externalId ?? targetResourceId.split(":").pop());
      if (!ip || !Number.isFinite(dropletId)) {
        throw new Error("Cannot determine reserved IP or droplet id for assignment");
      }
      await this.fetch(`/reserved_ips/${ip}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "assign", droplet_id: dropletId }),
      });
      return;
    }
    if (sourceTypeId === "nfs-share" && targetTypeId === "droplet") {
      // DO scopes NFS access at VPC level (per nfs_actions.yml: `attach`
      // takes `vpc_id`). Resolve the droplet's vpc_uuid and register
      // it on the share's allowed VPCs. The share's externalId is
      // `{region}/{shareId}`; extract the trailing id.
      const [share, droplet] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const shareRegion = String(share.fields["region"] ?? "");
      const dropletRegion = String(droplet.fields["region"] ?? "");
      if (shareRegion && dropletRegion && shareRegion !== dropletRegion) {
        throw new Error(
          `NFS share region ${shareRegion} does not match droplet region ${dropletRegion} — droplets can only mount shares in their own region.`,
        );
      }
      const dropletVpc = String(droplet.fields["vpcUuid"] ?? "");
      if (!dropletVpc) {
        throw new Error(
          "Couldn't determine the droplet's VPC — refresh the droplet and try again.",
        );
      }
      // Idempotent: if this VPC is already on the share's allow list,
      // there's nothing to do. DO would return 422 otherwise.
      const allowedVpcs = String(share.fields["vpcIds"] ?? "")
        .split(",")
        .filter(Boolean);
      if (allowedVpcs.includes(dropletVpc)) return;
      const shareExternalId = share.externalId ?? sourceResourceId.split(":").slice(2).join(":");
      // externalId is `{region}/{id}` — peel off the region prefix to
      // get the bare share id for the actions URL.
      const shareId = shareExternalId.includes("/")
        ? shareExternalId.split("/")[1]!
        : shareExternalId;
      await this.fetch(`/nfs/${shareId}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "attach", vpc_id: dropletVpc, region: shareRegion }),
      });
      return;
    }
    if (sourceTypeId === "gen-ai-knowledge-base" && targetTypeId === "gen-ai-agent") {
      const kbUuid = sourceResourceId.split(":").slice(2).join(":");
      const agentUuid = targetResourceId.split(":").slice(2).join(":");
      if (!kbUuid || !agentUuid) {
        throw new Error("Cannot determine knowledge base or agent UUID for attachment.");
      }
      await this.fetch(`/gen-ai/agents/${agentUuid}/knowledge_bases/${kbUuid}`, {
        method: "POST",
      });
      return;
    }
    throw new Error(
      `DigitalOcean plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateResult> {
    return doCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
  }

  /**
   * Inline field actions. The agent create form's Inference Router picker
   * exposes a "+ New router" action that mints an Inference Router on the
   * side (without leaving the agent form) and returns the new router's
   * UUID + label so the host can splice it into the picker's options and
   * select it. Other actions can be added here as they're declared.
   */
  async executeFieldAction(
    typeId: string,
    _fieldKey: string,
    actionId: string,
    _accountId: string,
    _fields: Record<string, string>,
    actionFields?: Record<string, string>,
  ): Promise<{ value: string; option?: { id: string; label: string } }> {
    if (typeId === "gen-ai-agent" && actionId === "create-workspace") {
      const af = actionFields ?? {};
      const name = String(af["name"] ?? "").trim();
      if (!name) throw new Error("Workspace name is required.");
      const body: Record<string, unknown> = {
        name,
        ...(af["description"] ? { description: af["description"] } : {}),
      };
      const data = await this.fetch<{ workspace: Record<string, unknown> }>("/gen-ai/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      const w = data.workspace ?? {};
      const uuid = String(w["uuid"] ?? "");
      if (!uuid) throw new Error("DigitalOcean did not return a workspace UUID.");
      return {
        value: uuid,
        option: { id: uuid, label: String(w["name"] ?? name) },
      };
    }
    if (typeId === "gen-ai-agent" && actionId === "create-inference-router") {
      const af = actionFields ?? {};
      const name = String(af["name"] ?? "").trim();
      if (!name) throw new Error("Router name is required.");
      const fallback = String(af["fallbackModels"] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        name,
        ...(af["description"] ? { description: af["description"] } : {}),
        ...(fallback.length ? { fallback_models: fallback } : {}),
      };
      const data = await this.fetch<{ model_router: Record<string, unknown> }>(
        "/gen-ai/models/routers",
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      const r = data.model_router ?? {};
      const uuid = String(r["uuid"] ?? "");
      if (!uuid) throw new Error("DigitalOcean did not return a router UUID.");
      return {
        value: uuid,
        option: { id: uuid, label: String(r["name"] ?? name) },
      };
    }
    throw new Error(
      `DigitalOcean plugin: executeFieldAction not supported for "${typeId}" / "${actionId}".`,
    );
  }

  private get actionCtx(): ActionContext {
    return {
      fetch: this.fetch.bind(this),
      getResource: this.getResource.bind(this),
    };
  }

  /**
   * Parameterless droplet & volume actions. The host calls this in response to
   * an `ActionNode` whose action is `{ type: "plugin-action", actionId }`.
   * Destructive actions are pre-confirmed by the host via `confirmMessage`.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "droplet") {
      return invokeDropletAction(this.actionCtx, resourceId, accountId, actionId);
    }
    if (typeId === "volume") {
      return invokeVolumeAction(this.actionCtx, resourceId, accountId, actionId);
    }
    if (typeId === "reserved-ip") {
      return invokeReservedIpAction(this.actionCtx, resourceId, accountId, actionId);
    }
    if (typeId === "gen-ai-agent") {
      const agentUuid = resourceId.split(":").slice(2).join(":");
      if (actionId === "make-public" || actionId === "make-private") {
        const visibility = actionId === "make-public" ? "VISIBILITY_PUBLIC" : "VISIBILITY_PRIVATE";
        await this.fetch<unknown>(`/gen-ai/agents/${agentUuid}/deployment_visibility`, {
          method: "PUT",
          body: JSON.stringify({ visibility }),
          headers: { "Content-Type": "application/json" },
        });
        return;
      }
      if (actionId === "regenerate-key") {
        // Not exposed as a header action on the agent itself, but on the
        // child key — kept here for symmetry once the row-action lands.
        return;
      }
    }
    if (typeId === "agent-api-key" && actionId === "regenerate") {
      // Composite resourceId — parse {agentUuid}/{keyUuid} from the
      // externalId, then PUT .../regenerate. DO returns a fresh secret_key
      // on this call (one-shot, same as create).
      const externalId = resourceId.split(":").slice(2).join(":");
      const parts = externalId.split("/");
      const agentUuid = parts[0]!;
      const keyUuid = parts[1]!;
      await this.fetch<unknown>(`/gen-ai/agents/${agentUuid}/api_keys/${keyUuid}/regenerate`, {
        method: "PUT",
      });
      return;
    }
    throw new Error(`DigitalOcean plugin: invokeAction not supported for type "${typeId}"`);
  }

  /**
   * In-memory fallback cache of `{ agentUuid → secret_key }` for hosts that
   * don't expose a secret write path. Lives on the client (not the module) so
   * it stays scoped to one account's token.
   */
  private readonly playgroundKeyCache = new Map<string, string>();

  private get nosqlCtx(): DoNoSqlContext {
    return {
      fetch: this.fetch.bind(this),
      services: this.services,
      actionCtx: this.actionCtx,
      playgroundKeyCache: this.playgroundKeyCache,
    };
  }

  /**
   * Parameterised droplet & volume commands plus the Gradient AI agent
   * playground — see `./nosql-console.ts`.
   */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    return executeDoNoSqlCommand(this.nosqlCtx, typeId, resourceId, accountId, command, args);
  }

  /**
   * Stream tokens from a deployed Gradient AI agent's OpenAI-compatible chat
   * completions endpoint — see `./nosql-console.ts`. The body of the iterable
   * is an async generator so plugins (and the host's IPC bridge) can
   * `for await (const event of stream) { … }`.
   */
  streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    return streamDoChatMessage(this.nosqlCtx, typeId, resourceId, accountId, messages);
  }
  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "droplet": {
        const stats: DashboardStat[] = [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: String(f["size"] ?? "") },
        ];
        if (resource.resolvedOutputs["ipv4"]) {
          stats.push({ label: "IPv4", value: resource.resolvedOutputs["ipv4"] });
        }
        const vcpus = Number(f["vcpus"] ?? 0);
        const memMb = Number(f["memoryMb"] ?? 0);
        if (vcpus > 0) stats.push({ label: "vCPU", value: String(vcpus) });
        if (memMb > 0) {
          stats.push({
            label: "Memory",
            value: `${(memMb / 1024).toFixed(memMb >= 1024 ? 0 : 1)} GB`,
          });
        }
        return stats;
      }
      case "snapshot":
        return [
          { label: "Source", value: String(f["resourceType"] ?? "") },
          ...(f["sizeGb"] ? [{ label: "Size", value: `${f["sizeGb"]} GB` }] : []),
        ];
      case "image":
        return [
          { label: "Type", value: String(f["type"] ?? "") },
          ...(f["distribution"]
            ? [{ label: "Distribution", value: String(f["distribution"]) }]
            : []),
          ...(f["sizeGb"] ? [{ label: "Size", value: `${f["sizeGb"]} GB` }] : []),
        ];
      case "nfs-share":
        return [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: `${String(f["sizeGib"] ?? 0)} GiB` },
          { label: "Tier", value: String(f["performanceTier"] ?? "") },
        ];
      case "volume":
        return [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: `${String(f["sizeGb"] ?? 0)} GB` },
          ...(f["dropletIds"] ? [{ label: "Attached", value: "Yes" }] : []),
        ];
      case "reserved-ip":
        return [
          { label: "IP", value: String(f["ip"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          {
            label: "Assigned",
            value: f["dropletId"]
              ? String(f["dropletName"] ?? f["dropletId"])
              : "No — billed while idle",
          },
        ];
      case "doks-cluster":
        return [
          { label: "Version", value: String(f["version"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Nodes", value: String(f["nodeCount"] ?? 0) },
        ];
      case "managed-database":
        return [
          { label: "Engine", value: String(f["engine"] ?? "") },
          { label: "Version", value: String(f["version"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Nodes", value: String(f["nodeCount"] ?? 1) },
        ];
      case "domain":
        return [{ label: "TTL", value: String(f["ttl"] ?? 1800) }];
      case "dns-record":
        return [
          { label: "Type", value: String(f["type"] ?? "") },
          { label: "Name", value: String(f["name"] ?? "") },
          { label: "Data", value: String(f["data"] ?? "") },
          ...(f["ttl"] != null ? [{ label: "TTL", value: String(f["ttl"]) }] : []),
        ];
      case "project": {
        const stats: DashboardStat[] = [{ label: "Name", value: String(f["name"] ?? "") }];
        if (f["environment"]) stats.push({ label: "Environment", value: String(f["environment"]) });
        if (f["purpose"]) stats.push({ label: "Purpose", value: String(f["purpose"]) });
        return stats;
      }
      case "spaces-bucket":
        return [
          { label: "Name", value: String(f["name"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          ...(f["accessControl"] ? [{ label: "Access", value: String(f["accessControl"]) }] : []),
        ];
      default:
        return [];
    }
  }

  /**
   * Logs tab for managed-databases. DO doesn't expose process logs over the
   * API — only the cluster event stream (creates, scale events, maintenance,
   * power cycles). We surface that as the closest available signal.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: { tailLines?: number },
  ): Promise<{ text: string; containers: string[]; activeContainer: string }> {
    if (typeId !== "managed-database") {
      return { text: "", containers: [], activeContainer: "" };
    }
    const externalId = resourceId.split(":").slice(2).join(":");
    const resp = await this.fetch<{
      events?: Array<{
        id?: string;
        event_type?: string;
        cluster_name?: string;
        create_time?: string;
      }>;
    }>(`/databases/${externalId}/events`);
    const events = resp.events ?? [];
    const tail = params.tailLines ?? 200;
    const lines = events
      .slice(-tail)
      .map(
        (e) =>
          `${e.create_time ?? "?"}  ${e.event_type ?? "unknown"}  ${e.cluster_name ?? ""}  (${e.id ?? ""})`,
      );
    const text =
      lines.length > 0
        ? lines.join("\n") + "\n"
        : "No cluster events yet. DO emits an event for create, scale, maintenance, and power-cycle actions — try again after one of those happens.\n";
    return { text, containers: ["events"], activeContainer: "events" };
  }

  private get metricCtx(): DoMetricContext {
    return {
      fetch: this.fetch.bind(this),
      getResource: this.getResource.bind(this),
    };
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    return fetchDoMetricSeries(this.metricCtx, resourceTypeId, resourceId, accountId, timeRange);
  }
  private get enrichCtx(): DoEnrichContext {
    return {
      fetch: this.fetch.bind(this),
      dropletCatalogCache: this.dropletCatalogCache,
      listSpacesBuckets: (accountId: string) => listSpacesBuckets(this.listerCtx, accountId),
    };
  }

  /**
   * Pre-fetch the catalog data the detail page's action prompts need to render
   * pickers instead of raw text inputs — see `./enrich-detail.ts`.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    return enrichDoDetail(this.enrichCtx, resource);
  }
  renderDetail(resource: ResourceInstance): DetailViewSchema {
    if (resource.resourceTypeId === "domain") {
      return renderDomainDetail(resource);
    }
    if (resource.resourceTypeId === "dns-record") {
      return renderDnsRecordDetail(resource);
    }
    const fields = resource.fields;
    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `${resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId)} \u00B7 ${String(fields["region"] ?? "")}`,
      status: doStatusDot(resource),
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: labeledFieldItems(fields, this.resourceTypes, resource.resourceTypeId),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };

    if (resource.resourceTypeId === "droplet") {
      applyDropletDetail(detail, resource);
    } else if (resource.resourceTypeId === "volume") {
      applyVolumeDetail(detail, resource);
    } else if (resource.resourceTypeId === "snapshot") {
      applySnapshotDetail(detail, resource);
    } else if (resource.resourceTypeId === "image") {
      applyImageDetail(detail, resource);
    } else if (resource.resourceTypeId === "nfs-share") {
      applyNfsShareDetail(detail, resource);
    } else if (resource.resourceTypeId === "reserved-ip") {
      applyReservedIpDetail(detail, resource);
    }

    if (resource.resourceTypeId === "spaces-bucket") {
      const bucketName = resource.externalId ?? String(fields["name"] ?? resource.displayName);
      detail.storageBrowser = { bucketName };
      detail.bucketPolicyEditor = {
        bucketArn: `arn:aws:s3:::${bucketName}`,
        bucketName,
        vendor: "do-spaces",
      };
    }

    if (resource.resourceTypeId === "managed-database") {
      applyManagedDatabaseDetail(detail, resource);
    } else if (resource.resourceTypeId === "db-user") {
      applyDatabaseUserDetail(detail, resource);
    } else if (resource.resourceTypeId === "gen-ai-agent") {
      applyGenAiAgentDetail(detail, resource);
    } else if (resource.resourceTypeId === "gen-ai-knowledge-base") {
      applyGenAiKnowledgeBaseDetail(detail, resource);
    } else if (resource.resourceTypeId === "gen-ai-model-router") {
      applyGenAiModelRouterDetail(detail, resource);
    }

    return detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "dns-record") {
      return renderDnsRecordSidebar(resource);
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: doStatusDot(resource),
    };
  }

  private async getSpacesConfig(bucket: string): Promise<S3StorageConfig> {
    const accessKey = this.credentials["spacesAccessKeyId"];
    const secretKey = this.credentials["spacesSecretAccessKey"];
    if (!accessKey || !secretKey) {
      throw new Error(
        "DigitalOcean plugin: Spaces storage requires S3-compatible credentials " +
          '("spacesAccessKeyId" and "spacesSecretAccessKey"). ' +
          "Generate these in the DigitalOcean console under API > Spaces Keys.",
      );
    }
    let region = this.spacesBucketRegions.get(bucket);
    if (!region) {
      // Cold cache: a list against any region returns 301 with the home region
      // in the `x-amz-bucket-region` header. The signing region doesn't have to
      // match the bucket region for this probe — S3 surfaces the redirect for
      // any signed GET on the bucket root.
      const probeRegion = SPACES_REGIONS[0] ?? "nyc3";
      const probeHost = `${bucket}.${probeRegion}.digitaloceanspaces.com`;
      const res = await signedS3Fetch({
        accessKey,
        secretKey,
        region: probeRegion,
        method: "HEAD",
        url: `https://${probeHost}/`,
      });
      const reported = res.headers.get("x-amz-bucket-region");
      region = reported || probeRegion;
      this.spacesBucketRegions.set(bucket, region);
    }
    return {
      accessKey,
      secretKey,
      region,
      buildUrl: virtualHostedUrl((r) => `${r}.digitaloceanspaces.com`)(region),
    };
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const cfg = await this.getSpacesConfig(bucket);
    return listS3Objects(cfg, bucket, prefix);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const cfg = await this.getSpacesConfig(bucket);
    return uploadS3Object(cfg, bucket, key, file);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const cfg = await this.getSpacesConfig(bucket);
    return makeS3Folder(cfg, bucket, key);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const cfg = await this.getSpacesConfig(bucket);
    return deleteS3Object(cfg, bucket, key);
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "spaces-bucket") {
      throw new Error(`DigitalOcean plugin: getManifest not supported for type "${typeId}"`);
    }
    const bucket = parts.slice(2).join(":");
    const cfg = await this.getSpacesConfig(bucket);
    const raw = await getS3BucketPolicy(cfg, bucket);
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "spaces-bucket") {
      throw new Error(`DigitalOcean plugin: applyManifest not supported for type "${typeId}"`);
    }
    const bucket = parts.slice(2).join(":");
    const cfg = await this.getSpacesConfig(bucket);
    return putS3BucketPolicy(cfg, bucket, manifest);
  }

  // Satisfy the required fields from DOKSClusterResourceType and ManagedDatabaseResourceType
  // so TypeScript knows they are used
  static readonly _resourceTypes = [
    DOKSClusterResourceType,
    ManagedDatabaseResourceType,
    SnapshotResourceType,
    ImageResourceType,
    NfsShareResourceType,
  ];
}

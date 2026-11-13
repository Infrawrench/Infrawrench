/**
 * Lending a cluster to a CI job: a self-contained kubeconfig with one
 * cluster, one user and one context, written to `/root/.kube/<alias>.yaml`
 * with `KUBECONFIG` pointing at it.
 *
 * A job has no credential plugins (`aws eks get-token`,
 * `gke-gcloud-auth-plugin`, `kubelogin`) and no local files, so what it gets
 * always carries its credentials inline:
 * - a kubeconfig with an inline token or client certificate passes them on
 *   for the chosen context;
 * - a service account token is swapped, where the cluster allows, for a
 *   short-lived one minted for the same service account with the
 *   TokenRequest API (`POST /api/v1/namespaces/{ns}/serviceaccounts/{name}/token`,
 *   `spec.expirationSeconds` at least 600), so the stored token never
 *   reaches the job; a cluster that refuses (RBAC) lends the stored token;
 * - a kubeconfig that signs in with a credential plugin is resolved by the
 *   host's Kubernetes driver the way it authenticates its own calls, and the
 *   bearer token that produces (short-lived by nature) is what the job gets.
 *   A host that will not run credential plugins (the cloud servers) refuses,
 *   and says why.
 *
 * Secret values (the token, the client key and certificate) are secret
 * parts; the rest of the file is shown, so a job's log masks only them.
 */
import yaml from "js-yaml";
import type { CiCredentialRequest, CiLentMaterial, CiLentValue } from "@infrawrench/plugin-base";

interface Named<T> {
  name?: string;
  [key: string]: unknown;
  value?: T;
}

interface ClusterEntry {
  server?: string;
  "certificate-authority-data"?: string;
  "tls-server-name"?: string;
  "insecure-skip-tls-verify"?: boolean;
}

interface UserEntry {
  token?: string;
  "client-certificate-data"?: string;
  "client-key-data"?: string;
  exec?: unknown;
  "auth-provider"?: unknown;
}

/** What the chosen context of a kubeconfig says. */
export interface KubeContext {
  server: string;
  caData?: string;
  tlsServerName?: string;
  insecure?: boolean;
  namespace?: string;
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
  /** The user signs in through a credential plugin or auth provider. */
  external: boolean;
}

function list(doc: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const raw = doc[key];
  return Array.isArray(raw) ? (raw.filter((e) => e && typeof e === "object") as never) : [];
}

function byName(
  entries: Array<Record<string, unknown>>,
  name: unknown,
  field: string,
): Record<string, unknown> | undefined {
  const entry = entries.find((e) => (e as Named<unknown>).name === name) ?? entries[0];
  const inner = entry?.[field];
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
}

/** The current context (or the first) of a kubeconfig. */
export function kubeContext(raw: string): KubeContext {
  const doc = yaml.load(raw) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") throw new Error("The kubeconfig is empty.");
  const contexts = list(doc, "contexts");
  const current = doc["current-context"];
  const context =
    byName(contexts, typeof current === "string" ? current : undefined, "context") ?? {};
  const cluster = (byName(list(doc, "clusters"), context["cluster"], "cluster") ??
    {}) as ClusterEntry;
  const user = (byName(list(doc, "users"), context["user"], "user") ?? {}) as UserEntry;
  if (!cluster.server) throw new Error("The kubeconfig names no cluster server.");
  const ns = context["namespace"];
  return {
    server: cluster.server.replace(/\/$/, ""),
    ...(cluster["certificate-authority-data"]
      ? { caData: cluster["certificate-authority-data"] }
      : {}),
    ...(cluster["tls-server-name"] ? { tlsServerName: cluster["tls-server-name"] } : {}),
    ...(cluster["insecure-skip-tls-verify"] === true ? { insecure: true } : {}),
    ...(typeof ns === "string" && ns ? { namespace: ns } : {}),
    ...(user.token ? { token: user.token } : {}),
    ...(user["client-certificate-data"] ? { clientCertData: user["client-certificate-data"] } : {}),
    ...(user["client-key-data"] ? { clientKeyData: user["client-key-data"] } : {}),
    external: Boolean(user.exec || user["auth-provider"]),
  };
}

/** The service account a token belongs to, when it is a service account's JWT. */
export function serviceAccountOf(token: string): { namespace: string; name: string } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { sub?: unknown };
    const match =
      typeof payload.sub === "string"
        ? /^system:serviceaccount:([^:]+):([^:]+)$/.exec(payload.sub)
        : null;
    return match ? { namespace: match[1]!, name: match[2]! } : null;
  } catch {
    return null;
  }
}

/** Inline credentials a job can use. */
export interface InlineCredentials {
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
}

const q = (value: string) => JSON.stringify(value);

/** The kubeconfig a job gets, as shown and secret parts. */
export function lentKubeconfig(
  ctx: KubeContext,
  creds: InlineCredentials,
  alias: string,
  namespace: string | undefined,
): CiLentValue {
  const parts: Array<{ text: string } | { secret: string }> = [];
  const text = (t: string) => parts.push({ text: t });
  // The secret itself is the masked part, so the bare value is masked
  // wherever a job prints it; a value JSON would have to escape is masked
  // quoted, as a whole.
  const secret = (s: string) => {
    if (/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)) {
      parts.push({ text: '"' }, { secret: s }, { text: '"' });
    } else {
      parts.push({ secret: q(s) });
    }
  };
  text(`apiVersion: v1\nkind: Config\nclusters:\n- name: ${q(alias)}\n  cluster:\n`);
  text(`    server: ${q(ctx.server)}\n`);
  if (ctx.caData) text(`    certificate-authority-data: ${q(ctx.caData)}\n`);
  if (ctx.tlsServerName) text(`    tls-server-name: ${q(ctx.tlsServerName)}\n`);
  if (ctx.insecure) text(`    insecure-skip-tls-verify: true\n`);
  text(`users:\n- name: ${q(alias)}\n  user:\n`);
  if (creds.token) {
    text("    token: ");
    secret(creds.token);
    text("\n");
  }
  if (creds.clientCertData) {
    text("    client-certificate-data: ");
    secret(creds.clientCertData);
    text("\n");
  }
  if (creds.clientKeyData) {
    text("    client-key-data: ");
    secret(creds.clientKeyData);
    text("\n");
  }
  text(
    `contexts:\n- name: ${q(alias)}\n  context:\n    cluster: ${q(alias)}\n    user: ${q(alias)}\n`,
  );
  if (namespace) text(`    namespace: ${q(namespace)}\n`);
  text(`current-context: ${q(alias)}\n`);
  return parts;
}

/** What the plugin needs from its client to lend. */
export interface LendDeps {
  kubeconfig: string;
  /** The host driver's view of the current context's credentials, when there is a driver. */
  driverCredentials?: () => Promise<InlineCredentials>;
  /** Mint a token for a service account; null when the cluster refuses. */
  mintToken: (
    sa: { namespace: string; name: string },
    seconds: number,
  ) => Promise<{ token: string; expiresAt?: string } | null>;
}

export async function lendKubeconfig(
  deps: LendDeps,
  request: Pick<CiCredentialRequest, "alias" | "namespace" | "ttlSeconds">,
): Promise<CiLentMaterial> {
  const ctx = kubeContext(deps.kubeconfig);
  // kubectl (client-go) sends no bearer token over plain HTTP, so a lent
  // kubeconfig without TLS would only ever fail as unauthorized.
  if (!ctx.server.startsWith("https://")) {
    throw new Error(
      `The cluster's API server (${ctx.server}) is not served over TLS, and kubectl sends no credentials without it.`,
    );
  }
  const namespace = request.namespace ?? ctx.namespace;
  let creds: InlineCredentials;
  let summary: string;
  let expiresAt: string | undefined;
  if (ctx.token || ctx.clientCertData) {
    creds = {
      ...(ctx.token ? { token: ctx.token } : {}),
      ...(ctx.clientCertData ? { clientCertData: ctx.clientCertData } : {}),
      ...(ctx.clientKeyData ? { clientKeyData: ctx.clientKeyData } : {}),
    };
    summary = ctx.token ? "the stored token" : "the stored client certificate";
    const sa = ctx.token ? serviceAccountOf(ctx.token) : null;
    if (sa) {
      const seconds = Math.max(600, Math.ceil(request.ttlSeconds));
      const minted = await deps.mintToken(sa, seconds).catch(() => null);
      if (minted) {
        creds = { token: minted.token };
        expiresAt = minted.expiresAt;
        summary = `a token for service account ${sa.namespace}/${sa.name}, ${Math.round(seconds / 60)} minutes`;
      }
    }
  } else if (ctx.external) {
    if (!deps.driverCredentials) {
      throw new Error(
        "This cluster's kubeconfig signs in with a credential plugin, which needs the Kubernetes driver to resolve.",
      );
    }
    let resolved: InlineCredentials;
    try {
      resolved = await deps.driverCredentials();
    } catch (err) {
      throw new Error(
        `This cluster's kubeconfig signs in with a credential plugin, which this Infrawrench host does not run (${err instanceof Error ? err.message : String(err)}). Connect the cluster with a token or a client certificate, or through its cloud connection.`,
        { cause: err },
      );
    }
    if (!resolved.token && !resolved.clientCertData) {
      throw new Error("The cluster's credential plugin gave no token or certificate.");
    }
    creds = resolved;
    summary = "a token from the kubeconfig's credential plugin";
  } else {
    throw new Error("The kubeconfig's user has no token, client certificate or credential plugin.");
  }
  const path = `/root/.kube/${request.alias}.yaml`;
  return {
    env: { KUBECONFIG: [{ text: path }] },
    files: [{ path, mode: "600", content: lentKubeconfig(ctx, creds, request.alias, namespace) }],
    ...(expiresAt ? { expiresAt } : {}),
    summary,
  };
}

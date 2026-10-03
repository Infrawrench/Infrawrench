/**
 * What a kubeconfig may contain when it is used on a shared, multi-tenant
 * server host (the cloud web and poller pods).
 *
 * Both `@kubernetes/client-node` and kubectl/k9s do far more with a
 * kubeconfig than talk to an API server: `users[].user.exec` and the legacy
 * `auth-provider` (`cmd-path`) run a local command, `tokenFile` /
 * `token-file`, `client-certificate`, `client-key` and
 * `certificate-authority` read local files, and `proxy-url` reroutes the
 * traffic. On the desktop that is the user's own machine and those features
 * are the point (gke-gcloud-auth-plugin, aws-iam-authenticator, kubelogin).
 * On the server they would run code and read files inside a pod shared by
 * every tenant, so there the kubeconfig must carry its credentials inline.
 *
 * This is an allowlist, not a denylist. Unknown keys are rejected rather
 * than ignored: kubectl decodes the file with a Go YAML/JSON stack whose
 * key matching does not have to agree with js-yaml's (a field spelled
 * `Exec` must not slip past a check for `exec`), so the only safe answer to
 * a key we do not recognise is "no".
 */
import yaml from "js-yaml";

const TOP_LEVEL_KEYS = new Set([
  "apiVersion",
  "kind",
  "clusters",
  "contexts",
  "users",
  "current-context",
  "preferences",
  "extensions",
]);

const NAMED_CLUSTER_KEYS = new Set(["name", "cluster"]);
const NAMED_USER_KEYS = new Set(["name", "user"]);
const NAMED_CONTEXT_KEYS = new Set(["name", "context"]);

const CLUSTER_KEYS = new Set([
  "server",
  "certificate-authority-data",
  "insecure-skip-tls-verify",
  "tls-server-name",
  "disable-compression",
  "extensions",
]);

const USER_KEYS = new Set([
  "token",
  "client-certificate-data",
  "client-key-data",
  "username",
  "password",
  "as",
  "as-uid",
  "as-groups",
  "as-user-extra",
  "extensions",
]);

const CONTEXT_KEYS = new Set(["cluster", "user", "namespace", "extensions"]);

/** Why a well-known but disallowed key is refused; anything else is just "not supported". */
const DISALLOWED_REASONS: Record<string, string> = {
  exec: "runs a local credential plugin command",
  "auth-provider": "runs a local auth-provider command",
  tokenFile: "reads a token from a local file",
  "token-file": "reads a token from a local file",
  "client-certificate": "reads a certificate from a local file",
  "client-key": "reads a key from a local file",
  "certificate-authority": "reads a CA bundle from a local file",
  "proxy-url": "routes cluster traffic through a proxy",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeKey(path: string, key: string): string {
  const reason = DISALLOWED_REASONS[key];
  return reason ? `${path}.${key} (${reason})` : `${path}.${key} (not supported)`;
}

function checkKeys(
  value: unknown,
  allowed: Set<string>,
  path: string,
  problems: string[],
): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    problems.push(`${path} (must be a mapping)`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push(describeKey(path, key));
  }
  return value;
}

function checkList(
  value: unknown,
  path: string,
  entryKeys: Set<string>,
  bodyKey: string,
  bodyKeys: Set<string>,
  problems: string[],
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    problems.push(`${path} (must be a list)`);
    return;
  }
  value.forEach((entry, i) => {
    const entryPath = `${path}[${i}]`;
    const named = checkKeys(entry, entryKeys, entryPath, problems);
    if (named) checkKeys(named[bodyKey], bodyKeys, `${entryPath}.${bodyKey}`, problems);
  });
}

/**
 * Every field in `raw` that makes it unsafe on a shared server host, as
 * human-readable paths (`users[0].user.exec (runs a local credential plugin
 * command)`). Empty means the kubeconfig only carries inline credentials.
 * An unparseable document is reported as a single problem rather than
 * thrown, so callers can treat "can't tell" exactly like "unsafe".
 */
export function findServerUnsafeKubeconfigFields(raw: string): string[] {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    return [`kubeconfig is not valid YAML (${err instanceof Error ? err.message : String(err)})`];
  }
  const problems: string[] = [];
  const root = checkKeys(doc, TOP_LEVEL_KEYS, "kubeconfig", problems);
  if (!root) {
    if (problems.length === 0) problems.push("kubeconfig is empty");
    return problems;
  }
  checkList(root["clusters"], "clusters", NAMED_CLUSTER_KEYS, "cluster", CLUSTER_KEYS, problems);
  checkList(root["users"], "users", NAMED_USER_KEYS, "user", USER_KEYS, problems);
  checkList(root["contexts"], "contexts", NAMED_CONTEXT_KEYS, "context", CONTEXT_KEYS, problems);
  return problems;
}

/**
 * The user-facing error for a kubeconfig that cannot be used on the server,
 * or null when it can.
 */
export function serverKubeconfigError(raw: string): string | null {
  const problems = findServerUnsafeKubeconfigFields(raw);
  if (problems.length === 0) return null;
  return (
    `This kubeconfig can't be used in Infrawrench cloud: ${problems.join("; ")}. ` +
    "Cloud accounts need credentials inline in the kubeconfig: a bearer token, " +
    "client-certificate-data and client-key-data, or a username and password. " +
    "Exec credential plugins, auth-provider, file paths and proxy-url only work in the desktop app."
  );
}

/** Throws `serverKubeconfigError`'s message when `raw` is unsafe on a server host. */
export function assertKubeconfigSafeForServer(raw: string): void {
  const error = serverKubeconfigError(raw);
  if (error) throw new Error(error);
}

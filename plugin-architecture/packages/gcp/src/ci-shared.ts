/**
 * What the GCP CI executors share: how they call Google (injectable, so tests
 * use a fake with no network), labels, the permission check, and the
 * service account Cloud Run and Cloud Build jobs run as.
 *
 * **Verified against Google's Discovery documents and docs, November 2026.**
 * There is no OpenAPI document for Compute Engine, Cloud Run or Cloud Build
 * (`$discovery/OPENAPI3_0` answers 404 for all three, so plugingen cannot
 * type them); the shapes here follow the Discovery documents
 * (compute v1, run v2, cloudbuild v1, iam v1, cloudresourcemanager v3).
 * - `cloudresourcemanager` v3 `projects/{id}:testIamPermissions`, body
 *   `{permissions}`, answers the granted subset.
 * - `iam` v1 `projects/{p}/serviceAccounts` (create, body `{accountId,
 *   serviceAccount: {displayName, description}}`, `accountId` 6 to 30 of
 *   `[a-z]([-a-z0-9]*[a-z0-9])`), `.../serviceAccounts/{email}` (get) and
 *   `...:testIamPermissions`.
 * - Labels: keys and values at most 63 characters of lowercase letters,
 *   digits, `_` and `-`; keys start with a letter.
 */
import type { CiMissingPermission } from "@infrawrench/plugin-base";

/** One authenticated JSON call; a non-2xx throws an error carrying `status`. */
export type GcpCall = <T>(
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
) => Promise<T>;

export interface GcpCiCalls {
  call: GcpCall;
  project: string;
  /** Waits between retries; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
}

export function sleepOf(calls: GcpCiCalls): (ms: number) => Promise<void> {
  return calls.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a failure says the API is switched off in the project. */
export function isApiDisabled(err: unknown): boolean {
  return (err as { apiDisabled?: unknown } | null)?.apiDisabled === true;
}

/** A tag as a GCP label key: lowercase, `[a-z0-9_-]`, starting with a letter, at most 63. */
export function labelKey(key: string): string {
  const safe = key
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 63);
  return /^[a-z]/.test(safe) ? safe : `t${safe}`.slice(0, 63);
}

/** A tag's value as a GCP label value: lowercase, `[a-z0-9_-]`, at most 63. */
export function labelValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 63);
}

/**
 * Labels for the job's tags. Labels cannot hold every tag as it was sent,
 * so each executor also keeps the tags as JSON where the provider keeps a
 * free string (instance metadata, a job annotation, a build substitution).
 */
export function labelsOf(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) out[labelKey(key)] = labelValue(value);
  return out;
}

/** The tags back from their JSON, or null when it is missing or malformed. */
export function parseTags(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/** The 32-hex job key as a UUID (version 4 bits set), for a `requestId`. */
export function uuidOf(key: string): string {
  const hex = key.padEnd(32, "0").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[parseInt(hex[16] ?? "0", 16) & 3] ?? "8";
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Which of `needed` the service account key lacks on the project. */
export async function missingOnProject(
  calls: GcpCiCalls,
  needed: readonly CiMissingPermission[],
): Promise<CiMissingPermission[]> {
  const answer = await calls.call<{ permissions?: string[] }>(
    "POST",
    `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(calls.project)}:testIamPermissions`,
    { permissions: [...new Set(needed.map((p) => p.permission))] },
  );
  const granted = new Set(answer.permissions ?? []);
  return needed.filter((p) => !granted.has(p.permission));
}

/**
 * The service account Cloud Run jobs and Cloud Build builds run as. Both
 * always run as some service account and hand its token to the workload
 * through the metadata server; left to themselves they use the project's
 * default one, which usually holds Editor. This one is given no roles, so
 * the token a job can fetch reaches nothing.
 */
export const CI_SERVICE_ACCOUNT_ID = "infrawrench-ci-runner";

export function serviceAccountEmail(project: string): string {
  // A domain-scoped project (`example.com:proj`) has its own address form.
  const colon = project.indexOf(":");
  return colon > 0
    ? `${CI_SERVICE_ACCOUNT_ID}@${project.slice(colon + 1)}.${project.slice(0, colon)}.iam.gserviceaccount.com`
    : `${CI_SERVICE_ACCOUNT_ID}@${project}.iam.gserviceaccount.com`;
}

function serviceAccountUrl(project: string): string {
  return `https://iam.googleapis.com/v1/projects/${encodeURIComponent(project)}/serviceAccounts/${encodeURIComponent(serviceAccountEmail(project))}`;
}

export const SERVICE_ACCOUNT_PERMISSIONS = {
  get: { permission: "iam.serviceAccounts.get", label: "Find the job's service account" },
  create: {
    permission: "iam.serviceAccounts.create",
    label: "Make the job's service account, which has no roles, on first use",
  },
  actAs: { permission: "iam.serviceAccounts.actAs", label: "Run the job as that service account" },
} as const satisfies Record<string, CiMissingPermission>;

/** Whether the CI service account is there (null when it cannot be read). */
export async function serviceAccountExists(calls: GcpCiCalls): Promise<boolean | null> {
  try {
    await calls.call("GET", serviceAccountUrl(calls.project));
    return true;
  } catch (err) {
    if (statusOf(err) === 404) return false;
    return null;
  }
}

/**
 * Make the CI service account when it is missing. Answers whether it was
 * just made: a new account takes up to a minute before it can be used.
 */
export async function ensureServiceAccount(calls: GcpCiCalls): Promise<boolean> {
  if (await serviceAccountExists(calls)) return false;
  try {
    await calls.call(
      "POST",
      `https://iam.googleapis.com/v1/projects/${encodeURIComponent(calls.project)}/serviceAccounts`,
      {
        accountId: CI_SERVICE_ACCOUNT_ID,
        serviceAccount: {
          displayName: "Infrawrench CI jobs",
          description:
            "Cloud Run jobs and Cloud Build builds started for Infrawrench CI run as this account. It has no roles: do not grant it any.",
        },
      },
    );
    return true;
  } catch (err) {
    // Made by a start running at the same time.
    if (statusOf(err) === 409) return false;
    throw err;
  }
}

/** The service-account permissions the key lacks: on the account when it exists, else on the project. */
export async function missingServiceAccountPermissions(
  calls: GcpCiCalls,
): Promise<CiMissingPermission[]> {
  const exists = await serviceAccountExists(calls);
  if (exists) {
    const answer = await calls.call<{ permissions?: string[] }>(
      "POST",
      `${serviceAccountUrl(calls.project)}:testIamPermissions`,
      { permissions: [SERVICE_ACCOUNT_PERMISSIONS.actAs.permission] },
    );
    return (answer.permissions ?? []).includes(SERVICE_ACCOUNT_PERMISSIONS.actAs.permission)
      ? []
      : [SERVICE_ACCOUNT_PERMISSIONS.actAs];
  }
  return missingOnProject(calls, Object.values(SERVICE_ACCOUNT_PERMISSIONS));
}

/** Retry a start that a just-made service account refused while it settles. */
export async function retryWhileAccountSettles<T>(
  calls: GcpCiCalls,
  fresh: boolean,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const settling =
        fresh &&
        attempt < 8 &&
        (statusOf(err) === 400 || statusOf(err) === 403 || statusOf(err) === 404) &&
        /service ?account|serviceAccount|does not exist|not found/i.test(errorText(err));
      if (!settling) throw err;
      await sleepOf(calls)(10_000);
    }
  }
}

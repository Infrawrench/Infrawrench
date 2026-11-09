/**
 * Secrets and variables for CI, kept by the CI proxy per owner (a GitHub
 * account) and per repository. The organization reaches only the accounts it
 * runs CI for: the scope is resolved from its own `ci_accounts` row, so it
 * can never name another owner's key. Secret values are write-only: the
 * proxy lists their names, and nothing here reads one back.
 */
import { and, eq } from "drizzle-orm";
import { CI_VALUE_NAME, type CiValues } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { ciAccounts } from "../db/schema.js";
import { accountOwnerKey } from "./events.js";
import { CiProxyError, proxyJson } from "./proxy.js";
import { CiInputError } from "./runs.js";

export type CiValueKind = "secrets" | "variables";

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

async function scopePath(
  organizationId: string,
  installationId: number,
  repo: string | null,
): Promise<string> {
  const [account] = await db
    .select({ accountLogin: ciAccounts.accountLogin })
    .from(ciAccounts)
    .where(
      and(
        eq(ciAccounts.organizationId, organizationId),
        eq(ciAccounts.installationId, installationId),
      ),
    )
    .limit(1);
  if (!account)
    throw new CiInputError("That GitHub account does not run CI for this organization.", 404);
  if (repo !== null && (!REPO_NAME.test(repo) || repo.includes(".."))) {
    throw new CiInputError("That is not a repository name.", 400);
  }
  const owner = encodeURIComponent(accountOwnerKey(account.accountLogin));
  return repo === null
    ? `/v1/orgs/${owner}`
    : `/v1/orgs/${owner}/repos/${encodeURIComponent(repo.toLowerCase())}`;
}

const segment = (kind: CiValueKind) => (kind === "secrets" ? "secrets" : "vars");
const iso = (seconds: unknown) =>
  new Date((typeof seconds === "number" ? seconds : 0) * 1000).toISOString();

/** The proxy's refusals as the route's; anything else stays an error. */
function refusal(err: unknown): never {
  if (err instanceof CiProxyError) {
    if (err.status === 400 || err.status === 404 || err.status === 409) {
      throw new CiInputError(err.message, err.status);
    }
    if (err.status === 503)
      throw new CiInputError("Secrets are not set up on the CI runner pool yet.", 409);
  }
  throw err;
}

export async function listCiValues(
  organizationId: string,
  installationId: number,
  repo: string | null,
): Promise<CiValues> {
  const base = await scopePath(organizationId, installationId, repo);
  try {
    const [secrets, vars] = await Promise.all([
      proxyJson<{ secrets?: Array<{ name: string; "updated-at"?: number }> }>(`${base}/secrets`),
      proxyJson<{ vars?: Array<{ name: string; value: string; "updated-at"?: number }> }>(
        `${base}/vars`,
      ),
    ]);
    return {
      installationId,
      repo,
      secrets: (secrets.secrets ?? []).map((s) => ({
        name: s.name,
        updatedAt: iso(s["updated-at"]),
      })),
      variables: (vars.vars ?? []).map((v) => ({
        name: v.name,
        value: v.value,
        updatedAt: iso(v["updated-at"]),
      })),
    };
  } catch (err) {
    return refusal(err);
  }
}

function checkName(name: string): void {
  if (!CI_VALUE_NAME.test(name)) {
    throw new CiInputError(
      "Names are letters, digits and _, not starting with a digit, up to 128.",
      400,
    );
  }
}

export async function setCiValue(
  organizationId: string,
  installationId: number,
  repo: string | null,
  kind: CiValueKind,
  name: string,
  value: string,
): Promise<void> {
  checkName(name);
  const base = await scopePath(organizationId, installationId, repo);
  try {
    await proxyJson(`${base}/${segment(kind)}/${name}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  } catch (err) {
    refusal(err);
  }
}

export async function deleteCiValue(
  organizationId: string,
  installationId: number,
  repo: string | null,
  kind: CiValueKind,
  name: string,
): Promise<void> {
  checkName(name);
  const base = await scopePath(organizationId, installationId, repo);
  try {
    await proxyJson(`${base}/${segment(kind)}/${name}`, { method: "DELETE" });
  } catch (err) {
    refusal(err);
  }
}

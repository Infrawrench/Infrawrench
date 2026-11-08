/**
 * Which of an organization's connected GitHub accounts (App installations)
 * run CI, and what the organization's CI looks like right now.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { CiAccount, CiStatus } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { ciAccounts, githubInstallations } from "../db/schema.js";
import { planAccess } from "../entitlements.js";
import { orgHasFeature } from "../features.js";
import { isGithubAppConfigured } from "../github/app.js";
import { ciProxyConfigured } from "./proxy.js";
import { CiInputError } from "./runs.js";

export async function ciAccountsOf(organizationId: string): Promise<CiAccount[]> {
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      ciId: ciAccounts.id,
    })
    .from(githubInstallations)
    .leftJoin(
      ciAccounts,
      and(
        eq(ciAccounts.installationId, githubInstallations.installationId),
        eq(ciAccounts.organizationId, githubInstallations.organizationId),
      ),
    )
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(githubInstallations.accountLogin);
  return rows.map((r) => ({
    installationId: r.installationId,
    accountLogin: r.accountLogin ?? String(r.installationId),
    accountType: r.accountType,
    ciEnabled: r.ciId !== null,
  }));
}

export async function ciStatus(organizationId: string): Promise<CiStatus> {
  const enabled = await orgHasFeature(organizationId, "ci");
  return {
    enabled,
    configured: ciProxyConfigured(),
    githubConfigured: isGithubAppConfigured(),
    planIncludesCi: (await planAccess(organizationId)).paid,
    accounts: enabled ? await ciAccountsOf(organizationId) : [],
  };
}

/** Turns CI on or off for one of the organization's GitHub accounts. */
export async function setCiAccount(
  organizationId: string,
  installationId: number,
  enabled: boolean,
  userId: string,
): Promise<CiAccount> {
  const [installation] = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        eq(githubInstallations.installationId, installationId),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .limit(1);
  if (!installation)
    throw new CiInputError("That GitHub account is not connected to this organization.", 404);
  const accountLogin = installation.accountLogin ?? String(installationId);
  if (enabled) {
    await db
      .insert(ciAccounts)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        installationId,
        accountLogin,
        enabledByUserId: userId,
      })
      .onConflictDoNothing();
  } else {
    await db
      .delete(ciAccounts)
      .where(
        and(
          eq(ciAccounts.organizationId, organizationId),
          eq(ciAccounts.installationId, installationId),
        ),
      );
  }
  return {
    installationId,
    accountLogin,
    accountType: installation.accountType,
    ciEnabled: enabled,
  };
}

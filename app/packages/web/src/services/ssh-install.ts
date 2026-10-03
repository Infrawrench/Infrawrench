import { and, eq, isNull } from "drizzle-orm";
import type {
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugins/loader";
import { getClientForAccount } from "./plugin-clients";
import { resolveSshConfig } from "./ssh";
import { connectSshInstaller } from "./ssh-install-transport";

export async function listSshInstallAccounts(organizationId: string): Promise<SshInstallAccount[]> {
  const plugins = await loadPlugins();
  const rows = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  return rows.flatMap((row) => {
    const manifest = plugins.find(({ plugin }) => plugin.manifest.id === row.pluginId)?.plugin
      .manifest;
    return manifest?.sshInstall
      ? [
          {
            accountId: row.id,
            displayName: row.displayName,
            pluginId: row.pluginId,
            serviceName: manifest.displayName,
            description: manifest.sshInstall.description,
            logoSvg: manifest.logoSvg,
          },
        ]
      : [];
  });
}

/** Resolve the selected resource in its org; clients cannot supply an arbitrary host or command. */
export async function runSshInstall(
  organizationId: string,
  input: SshInstallInput,
): Promise<SshInstallResult> {
  const available = await listSshInstallAccounts(organizationId);
  if (!available.some((a) => a.accountId === input.installerAccountId))
    throw new Error("Installer account not found.");
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .innerJoin(accounts, eq(resources.accountId, accounts.id))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.id, input.target.resourceId),
        eq(resources.accountId, input.target.accountId),
        eq(resources.resourceTypeId, input.target.resourceTypeId),
        isNull(resources.deletedAt),
        isNull(accounts.deletedAt),
        eq(accounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new Error("SSH target not found.");
  const target = await getClientForAccount(input.target.accountId, organizationId);
  const installer = await getClientForAccount(input.installerAccountId, organizationId);
  if (!target || !installer?.plugin.manifest.sshInstall || !installer.client.installOnSsh)
    throw new Error("SSH installer unavailable.");
  if (target.plugin.manifest.sshInstall)
    throw new Error("This resource cannot be a target of an SSH service installer.");
  const type = target.plugin.resourceTypes.find((t) => t.id === input.target.resourceTypeId);
  if (!type?.sshEndpoint && !(type?.supportsTerminal && target.client.getSshConfig))
    throw new Error("This resource does not expose SSH.");
  const resource = await target.client.getResource(
    input.target.resourceTypeId,
    input.target.resourceId,
    input.target.accountId,
  );
  const endpoint = type.sshEndpoint;
  if (
    endpoint?.runningWhen &&
    String(resource.fields[endpoint.runningWhen.fieldKey]).toLowerCase() !==
      endpoint.runningWhen.value.toLowerCase()
  )
    throw new Error("Start this server before installing a service.");
  const host = endpoint
    ? String(
        resource.resolvedOutputs[endpoint.hostOutputKey] ||
          resource.fields[endpoint.hostOutputKey] ||
          (await target.client.resolveOutput(
            input.target.resourceTypeId,
            input.target.resourceId,
            endpoint.hostOutputKey,
            input.target.accountId,
          )),
      )
    : undefined;
  const username =
    input.username ||
    (endpoint?.usernameFieldKey ? String(resource.fields[endpoint.usernameFieldKey] || "") : "") ||
    endpoint?.defaultUsername ||
    "root";
  const config = await resolveSshConfig(target.client, organizationId, {
    ...(input.sshKeyId ? { sshKeyId: input.sshKeyId } : {}),
    ...(host ? { sshHost: host } : {}),
    sshUsername: username,
  });
  if (!target.client.getSshConfig && input.port) config.port = input.port;
  const transport = await connectSshInstaller(
    organizationId,
    config,
    target.credentials.connectThroughAccountId,
  );
  try {
    return await installer.client.installOnSsh(transport);
  } finally {
    transport.close();
  }
}

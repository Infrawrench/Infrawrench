import type {
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { resolveSshChain } from "@infrawrench/plugin-ssh";
import { getDb } from "../db/client";
import { loadPlugins, getPlugin } from "../plugins/loader";
import { createPluginClient } from "./plugin-client";
import { invoke } from "./invoke";

export async function listLocalSshInstallAccounts(): Promise<SshInstallAccount[]> {
  const db = await getDb();
  const [rows, plugins] = await Promise.all([
    db.select<Array<{ id: string; display_name: string; plugin_id: string }>>(
      "SELECT id, display_name, plugin_id FROM accounts",
      [],
    ),
    loadPlugins(),
  ]);
  return rows.flatMap((row) => {
    const manifest = plugins.find(({ plugin }) => plugin.manifest.id === row.plugin_id)?.plugin
      .manifest;
    return manifest?.sshInstall
      ? [
          {
            accountId: row.id,
            displayName: row.display_name,
            pluginId: row.plugin_id,
            serviceName: manifest.displayName,
            description: manifest.sshInstall.description,
            logoSvg: manifest.logoSvg,
          },
        ]
      : [];
  });
}

export async function runLocalSshInstall(
  input: SshInstallInput,
  privateKey: string,
): Promise<SshInstallResult> {
  const db = await getDb();
  const [row] = await db.select<Array<{ plugin_id: string }>>(
    "SELECT plugin_id FROM accounts WHERE id = $1",
    [input.target.accountId],
  );
  const account = (await listLocalSshInstallAccounts()).find(
    (a) => a.accountId === input.installerAccountId,
  );
  if (!row || !account) throw new Error("Account not found.");
  const targetClient = await createPluginClient(input.target.accountId, row.plugin_id);
  const installer = await createPluginClient(account.accountId, account.pluginId);
  if (!installer.installOnSsh) throw new Error("This service cannot be installed over SSH.");
  const plugin = await getPlugin(row.plugin_id);
  if (plugin?.plugin.manifest.sshInstall)
    throw new Error("This resource cannot be a target of an SSH service installer.");
  const type = plugin?.plugin.resourceTypes.find((t) => t.id === input.target.resourceTypeId);
  const native = targetClient.getSshConfig?.();
  if (!type?.sshEndpoint && !(type?.supportsTerminal && native))
    throw new Error("This resource does not expose SSH.");
  const resource = await targetClient.getResource(
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
  const host =
    native?.host ||
    (endpoint
      ? String(
          resource.resolvedOutputs[endpoint.hostOutputKey] ||
            resource.fields[endpoint.hostOutputKey] ||
            (await targetClient.resolveOutput(
              input.target.resourceTypeId,
              input.target.resourceId,
              endpoint.hostOutputKey,
              input.target.accountId,
            )),
        )
      : "");
  if (!host) throw new Error("Could not resolve this server's SSH address.");
  const credentials = await invoke<Record<string, string>>("account_get_credentials", {
    accountId: input.target.accountId,
  });
  const jumpHops = credentials.connectThroughAccountId
    ? await resolveSshChain(credentials.connectThroughAccountId, async (accountId) => {
        const [hop] = await db.select<Array<{ plugin_id: string }>>(
          "SELECT plugin_id FROM accounts WHERE id = $1",
          [accountId],
        );
        if (hop?.plugin_id !== "ssh") throw new Error("SSH jump account not found.");
        const client = await createPluginClient(accountId, hop.plugin_id);
        const creds = await invoke<Record<string, string>>("account_get_credentials", {
          accountId,
        });
        return {
          ...client.getSshConfig!(),
          ...(creds.connectThroughAccountId
            ? { connectThroughAccountId: creds.connectThroughAccountId }
            : {}),
        };
      })
    : [];
  const config = {
    host,
    port: native?.port ?? input.port ?? 22,
    username: native?.username || input.username || endpoint?.defaultUsername || "root",
    privateKey: native?.privateKey || privateKey,
    jumpHops,
    cols: 80,
    rows: 24,
  };
  return installer.installOnSsh({
    exec: (script) => invoke<string>("ssh_exec_script", { config, script }),
  });
}

import { useCallback, useEffect, useState } from "react";
import {
  AddAccountModal as SharedAddAccountModal,
  type AccountReferenceOption,
  type PluginInfo,
} from "@infrawrench/ui";
import { runAccountPreflight, type PolicyTemplate } from "@infrawrench/client-core";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { loadPlugins, getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { createCloudAccount } from "../lib/cloud-api";

interface Props {
  onClose: () => void;
  onAdded: () => void;
  orgId?: string | null;
  prefilledPluginId?: string;
  prefilledCredentials?: Record<string, string>;
  prefilledDisplayName?: string;
}

type LocalAccountRow = Pick<AccountRow, "id" | "plugin_id" | "display_name">;

export function AddAccountModal({
  onClose,
  onAdded,
  orgId,
  prefilledPluginId,
  prefilledCredentials,
  prefilledDisplayName,
}: Props) {
  const [accounts, setAccounts] = useState<AccountReferenceOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<LocalAccountRow[]>(
          "SELECT id, plugin_id, display_name FROM accounts ORDER BY display_name",
        );
        if (cancelled) return;
        setAccounts(
          rows.map((r) => ({ id: r.id, pluginId: r.plugin_id, displayName: r.display_name })),
        );
      } catch (err) {
        console.error("[add-account] Failed to load accounts:", err);
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoadPlugins = useCallback(async (): Promise<PluginInfo[]> => {
    const loaded = await loadPlugins();
    return loaded.map((l) => ({
      id: l.plugin.manifest.id,
      displayName: l.plugin.manifest.displayName,
      logoSvg: l.plugin.manifest.logoSvg,
      preflight: l.plugin.manifest.preflight ?? null,
      credentialFields: l.plugin.manifest.credentialFields.map((f) => ({
        key: f.key,
        label: f.label,
        ...(f.description !== undefined ? { description: f.description } : {}),
        ...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
        sensitive: f.sensitive,
        ...(f.multiline !== undefined ? { multiline: f.multiline } : {}),
        ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
        ...(f.regions !== undefined ? { regions: f.regions } : {}),
        ...(f.optional !== undefined ? { optional: f.optional } : {}),
        ...(f.accountReference !== undefined ? { accountReference: f.accountReference } : {}),
        ...(f.helpLink !== undefined ? { helpLink: f.helpLink } : {}),
      })),
    }));
  }, []);

  // Desktop doesn't expose bastions today; the bastionId argument from the
  // shared modal is ignored here.
  const saveAccount = useCallback(
    async (
      pluginId: string,
      displayName: string,
      credentials: Record<string, string>,
      _bastionId: string | null,
    ) => {
      if (orgId) {
        await createCloudAccount(orgId, pluginId, displayName, credentials);
        return;
      }
      const accountId = crypto.randomUUID();
      await invoke<void>("account_create", { accountId, pluginId, displayName, credentials });
    },
    [orgId],
  );

  // Preflight runs entirely in the renderer — plugins are bundled locally, so
  // no server round-trip is needed even for cloud-org accounts.
  const runPreflight = useCallback(
    async (pluginId: string, credentials: Record<string, string>, _bastionId: string | null) => {
      const loaded = await getPlugin(pluginId);
      if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
      const services = buildPluginHostServices(loaded.plugin.manifest, credentials);
      const client = loaded.plugin.createClient(credentials, services);
      return runAccountPreflight(loaded.plugin, client);
    },
    [],
  );

  const fetchPolicyTemplate = useCallback(
    async (pluginId: string, capabilityIds: string[]): Promise<PolicyTemplate> => {
      const loaded = await getPlugin(pluginId);
      if (!loaded?.plugin.policyTemplate) {
        throw new Error(`Plugin "${pluginId}" does not provide a policy template`);
      }
      return loaded.plugin.policyTemplate(capabilityIds);
    },
    [],
  );

  return (
    <SharedAddAccountModal
      onClose={onClose}
      onAdded={onAdded}
      loadPlugins={handleLoadPlugins}
      saveAccount={saveAccount}
      runPreflight={runPreflight}
      fetchPolicyTemplate={fetchPolicyTemplate}
      accounts={accounts}
      onOpenExternal={(url) => void invoke("open_external_url", { url })}
      {...(prefilledPluginId ? { prefilledPluginId } : {})}
      {...(prefilledCredentials ? { prefilledCredentials } : {})}
      {...(prefilledDisplayName ? { prefilledDisplayName } : {})}
    />
  );
}

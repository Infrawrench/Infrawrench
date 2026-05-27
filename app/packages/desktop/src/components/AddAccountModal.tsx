import { useCallback, useEffect, useState } from "react";
import {
  AddAccountModal as SharedAddAccountModal,
  type AccountReferenceOption,
  type PluginInfo,
} from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { loadPlugins } from "../plugins/loader";
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
      } catch {
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

  return (
    <SharedAddAccountModal
      onClose={onClose}
      onAdded={onAdded}
      loadPlugins={handleLoadPlugins}
      saveAccount={saveAccount}
      accounts={accounts}
      onOpenExternal={(url) => void invoke("open_external_url", { url })}
      {...(prefilledPluginId ? { prefilledPluginId } : {})}
      {...(prefilledCredentials ? { prefilledCredentials } : {})}
      {...(prefilledDisplayName ? { prefilledDisplayName } : {})}
    />
  );
}

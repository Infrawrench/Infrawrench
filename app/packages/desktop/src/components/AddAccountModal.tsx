import { useCallback } from "react";
import { AddAccountModal as SharedAddAccountModal, type PluginInfo } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { loadPlugins } from "../plugins/loader";
import { getDb } from "../db/client";
import { createCloudAccount } from "../lib/cloud-api";

interface Props {
  onClose: () => void;
  onAdded: () => void;
  orgId?: string | null;
}

export function AddAccountModal({ onClose, onAdded, orgId }: Props) {
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
      })),
    }));
  }, []);

  const saveAccount = useCallback(
    async (pluginId: string, displayName: string, credentials: Record<string, string>) => {
      if (orgId) {
        await createCloudAccount(orgId, pluginId, displayName, credentials);
        return;
      }
      const credJson = JSON.stringify(credentials);
      const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>("encrypt_value", {
        plaintext: credJson,
      });
      const db = await getDb();
      const id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, pluginId, displayName, ciphertext, iv],
      );
    },
    [orgId],
  );

  return (
    <SharedAddAccountModal
      onClose={onClose}
      onAdded={onAdded}
      loadPlugins={handleLoadPlugins}
      saveAccount={saveAccount}
    />
  );
}

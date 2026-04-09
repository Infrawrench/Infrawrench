import { useCallback } from "react";
import { AddAccountModal as SharedAddAccountModal, type PluginInfo } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { loadPlugins } from "../plugins/loader";
import { getDb } from "../db/client";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

export function AddAccountModal({ onClose, onAdded }: Props) {
  const handleLoadPlugins = useCallback(async (): Promise<PluginInfo[]> => {
    const loaded = await loadPlugins();
    return loaded.map((l) => ({
      id: l.plugin.manifest.id,
      displayName: l.plugin.manifest.displayName,
      logoSvg: l.plugin.manifest.logoSvg,
      credentialFields: l.plugin.manifest.credentialFields.map((f) => ({
        key: f.key,
        label: f.label,
        description: f.description,
        placeholder: f.placeholder,
        sensitive: f.sensitive,
        multiline: f.multiline,
        defaultValue: f.defaultValue,
      })),
    }));
  }, []);

  const saveAccount = useCallback(
    async (pluginId: string, displayName: string, credentials: Record<string, string>) => {
      const credJson = JSON.stringify(credentials);
      const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: credJson },
      );
      const db = await getDb();
      const id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, pluginId, displayName, ciphertext, iv],
      );
    },
    [],
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

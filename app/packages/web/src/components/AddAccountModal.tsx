import { useCallback } from "react";
import { AddAccountModal as SharedAddAccountModal, type PluginInfo } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

export function AddAccountModal({ onClose, onAdded }: Props) {
  const loadPlugins = useCallback(
    () => apiGet<PluginInfo[]>("/api/accounts/plugins"),
    [],
  );

  const saveAccount = useCallback(
    (pluginId: string, displayName: string, credentials: Record<string, string>) =>
      apiPost<void>("/api/accounts", { pluginId, displayName, credentials }),
    [],
  );

  return (
    <SharedAddAccountModal
      onClose={onClose}
      onAdded={onAdded}
      loadPlugins={loadPlugins}
      saveAccount={saveAccount}
    />
  );
}

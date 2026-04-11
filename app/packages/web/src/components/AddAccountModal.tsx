import { useCallback } from "react";
import { AddAccountModal as SharedAddAccountModal, type PluginInfo } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

export function AddAccountModal({ onClose, onAdded }: Props) {
  const orgId = useOrgId();

  const loadPlugins = useCallback(
    () => apiGet<PluginInfo[]>(`/api/org/${orgId}/accounts/plugins`),
    [orgId],
  );

  const saveAccount = useCallback(
    (pluginId: string, displayName: string, credentials: Record<string, string>) =>
      apiPost<void>(`/api/org/${orgId}/accounts`, { pluginId, displayName, credentials }),
    [orgId],
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

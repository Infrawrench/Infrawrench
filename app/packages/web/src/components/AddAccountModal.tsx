import { useCallback } from "react";
import { AddAccountModal as SharedAddAccountModal, toast, type PluginInfo } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

interface CreateAccountResponse {
  id: string;
  syncError?: { message: string };
}

export function AddAccountModal({ onClose, onAdded }: Props) {
  const orgId = useOrgId();

  const loadPlugins = useCallback(
    () => apiGet<PluginInfo[]>(`/api/org/${orgId}/accounts/plugins`),
    [orgId],
  );

  const saveAccount = useCallback(
    async (pluginId: string, displayName: string, credentials: Record<string, string>) => {
      const result = await apiPost<CreateAccountResponse>(`/api/org/${orgId}/accounts`, {
        pluginId,
        displayName,
        credentials,
      });
      if (result?.syncError) {
        toast.warning("Account created but initial sync failed", {
          description: result.syncError.message,
        });
      }
    },
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

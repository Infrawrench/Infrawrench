import { useCallback, useEffect, useState } from "react";
import {
  AddAccountModal as SharedAddAccountModal,
  toast,
  type BastionOption,
  type PluginInfo,
} from "@infrawrench/ui";
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

interface BastionListItem {
  id: string;
  name: string;
  connected: boolean;
  status: string;
}

export function AddAccountModal({ onClose, onAdded }: Props) {
  const orgId = useOrgId();
  const [bastions, setBastions] = useState<BastionOption[]>([]);

  const loadPlugins = useCallback(
    () => apiGet<PluginInfo[]>(`/api/org/${orgId}/accounts/plugins`),
    [orgId],
  );

  useEffect(() => {
    apiGet<BastionListItem[]>(`/api/org/${orgId}/bastions`)
      .then((rows) =>
        setBastions(
          rows
            .filter((r) => r.status !== "revoked")
            .map((r) => ({ id: r.id, name: r.name, connected: r.connected })),
        ),
      )
      .catch(() => setBastions([]));
  }, [orgId]);

  const saveAccount = useCallback(
    async (
      pluginId: string,
      displayName: string,
      credentials: Record<string, string>,
      bastionId: string | null,
    ) => {
      const result = await apiPost<CreateAccountResponse>(`/api/org/${orgId}/accounts`, {
        pluginId,
        displayName,
        credentials,
        bastionId,
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
      bastions={bastions}
    />
  );
}

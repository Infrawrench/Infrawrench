import { useCallback, useEffect, useState } from "react";
import {
  AddAccountModal as SharedAddAccountModal,
  toast,
  type AccountReferenceOption,
  type BastionOption,
  type PluginInfo,
} from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import type { AccountListItem, Bastion } from "@/lib/api-types";

interface Props {
  onClose: () => void;
  onAdded: () => void;
  prefilledPluginId?: string;
  prefilledCredentials?: Record<string, string>;
  prefilledDisplayName?: string;
}

interface CreateAccountResponse {
  id: string;
  syncError?: { message: string };
}

/** Just the fields the "Egress via" picker needs from the `Bastion` row. */
type BastionListItem = Pick<Bastion, "id" | "name" | "connected" | "status">;

export function AddAccountModal({
  onClose,
  onAdded,
  prefilledPluginId,
  prefilledCredentials,
  prefilledDisplayName,
}: Props) {
  const orgId = useOrgId();
  const [bastions, setBastions] = useState<BastionOption[]>([]);
  const [accounts, setAccounts] = useState<AccountReferenceOption[]>([]);

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

  useEffect(() => {
    apiGet<AccountListItem[]>(`/api/org/${orgId}/accounts`)
      .then((rows) =>
        setAccounts(
          rows.map((r) => ({ id: r.id, pluginId: r.pluginId, displayName: r.displayName })),
        ),
      )
      .catch(() => setAccounts([]));
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
      accounts={accounts}
      {...(prefilledPluginId ? { prefilledPluginId } : {})}
      {...(prefilledCredentials ? { prefilledCredentials } : {})}
      {...(prefilledDisplayName ? { prefilledDisplayName } : {})}
    />
  );
}

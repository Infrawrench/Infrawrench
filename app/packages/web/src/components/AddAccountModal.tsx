import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  AddAccountModal as SharedAddAccountModal,
  toast,
  type AccountReferenceOption,
  type BastionOption,
} from "@infrawrench/ui";
import type { PolicyTemplate, PreflightReport } from "@infrawrench/client-core";
import { apiGet, apiPost } from "@/lib/api";
import { fetchPluginCatalog } from "@/lib/plugin-catalog";
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
  const gt = useGT();
  const orgId = useOrgId();
  const [bastions, setBastions] = useState<BastionOption[]>([]);
  const [accounts, setAccounts] = useState<AccountReferenceOption[]>([]);

  const loadPlugins = useCallback(() => fetchPluginCatalog(orgId), [orgId]);

  useEffect(() => {
    apiGet<BastionListItem[]>(`/api/org/${orgId}/bastions`)
      .then((rows) =>
        setBastions(
          rows.flatMap((r) =>
            r.status !== "revoked" ? [{ id: r.id, name: r.name, connected: r.connected }] : [],
          ),
        ),
      )
      .catch((e: unknown) => {
        // A failed load must not render as "no bastions" — the picker would
        // silently offer only direct connections.
        toast.error(gt("Failed to load bastions"), {
          description: e instanceof Error ? e.message : String(e),
        });
      });
  }, [orgId, gt]);

  useEffect(() => {
    apiGet<AccountListItem[]>(`/api/org/${orgId}/accounts`)
      .then((rows) =>
        setAccounts(
          rows.map((r) => ({ id: r.id, pluginId: r.pluginId, displayName: r.displayName })),
        ),
      )
      .catch((e: unknown) => {
        // Same as bastions: don't render a failed load as "no accounts".
        toast.error(gt("Failed to load accounts"), {
          description: e instanceof Error ? e.message : String(e),
        });
      });
  }, [orgId, gt]);

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
        toast.warning(gt("Account created but initial sync failed"), {
          description: result.syncError.message,
        });
      }
    },
    [orgId, gt],
  );

  const runPreflight = useCallback(
    (pluginId: string, credentials: Record<string, string>, bastionId: string | null) =>
      apiPost<PreflightReport>(`/api/org/${orgId}/accounts/preflight`, {
        pluginId,
        credentials,
        bastionId,
      }),
    [orgId],
  );

  const fetchPolicyTemplate = useCallback(
    async (pluginId: string, capabilityIds: string[]) => {
      const { template } = await apiGet<{ template: PolicyTemplate }>(
        `/api/org/${orgId}/accounts/plugins/${pluginId}/policy-template?capabilities=${encodeURIComponent(
          capabilityIds.join(","),
        )}`,
      );
      return template;
    },
    [orgId],
  );

  return (
    <SharedAddAccountModal
      onClose={onClose}
      onAdded={onAdded}
      loadPlugins={loadPlugins}
      saveAccount={saveAccount}
      runPreflight={runPreflight}
      fetchPolicyTemplate={fetchPolicyTemplate}
      bastions={bastions}
      accounts={accounts}
      {...(prefilledPluginId ? { prefilledPluginId } : {})}
      {...(prefilledCredentials ? { prefilledCredentials } : {})}
      {...(prefilledDisplayName ? { prefilledDisplayName } : {})}
    />
  );
}

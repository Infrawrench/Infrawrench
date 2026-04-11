import { useState, useEffect, useMemo, useCallback } from "react";
import {
  CreateResourceModal as SharedCreateResourceModal,
  FieldRenderer,
  useCreateResourceForm,
  type SshKeyEntry,
} from "@infrawrench/ui";
import type { CreateResourceConfig } from "@infrawrench/plugin-base";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface Props {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceTypeDisplayName: string;
  onClose: () => void;
  onCreated: (resource: { id: string; displayName: string }) => void;
}

export function CreateResourceModal({
  accountId,
  pluginId,
  resourceTypeId,
  resourceTypeDisplayName,
  onClose,
  onCreated,
}: Props) {
  const orgId = useOrgId();
  const [currentUserId, setCurrentUserId] = useState<string | undefined>();

  useEffect(() => {
    apiGet<{ userId: string }>("/api/auth/me").then((s) => setCurrentUserId(s.userId));
  }, []);

  const loadSshKeys = useCallback(
    () => apiGet<SshKeyEntry[]>(`/api/org/${orgId}/ssh-keys`),
    [orgId],
  );
  const generateSshKey = useCallback(
    (name: string) =>
      apiPost<SshKeyEntry & { privateKey?: string }>(`/api/org/${orgId}/ssh-keys`, { name }),
    [orgId],
  );
  const deleteSshKey = useCallback(
    (id: string) => apiDelete<void>(`/api/org/${orgId}/ssh-keys/${id}`),
    [orgId],
  );

  const callbacks = useMemo(
    () => ({
      loadConfig: () =>
        apiPost<CreateResourceConfig>(`/api/org/${orgId}/resources/create-config`, {
          accountId,
          resourceTypeId,
        }),
      loadSizePricing: (request: {
        regionId?: string;
        sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
      }) =>
        apiPost<Record<string, number>>(`/api/org/${orgId}/resources/create-pricing`, {
          accountId,
          resourceTypeId,
          ...(request.regionId ? { regionId: request.regionId } : {}),
          sizes: request.sizes,
        }),
      loadCostEstimate: (fields: Record<string, string>) =>
        apiPost<{ estimate: number | null }>(`/api/org/${orgId}/resources/create-cost-estimate`, {
          accountId,
          resourceTypeId,
          fields,
        }).then(({ estimate }) => estimate),
      create: async (fields: Record<string, string>) => {
        const created = await apiPost<{ id: string; displayName: string }>(
          `/api/org/${orgId}/resources/create`,
          {
            accountId,
            pluginId,
            resourceTypeId,
            fields,
          },
        );
        onCreated(created);
      },
    }),
    [accountId, orgId, pluginId, resourceTypeId, onCreated],
  );

  const form = useCreateResourceForm(callbacks, [accountId, resourceTypeId]);

  return (
    <SharedCreateResourceModal
      displayName={resourceTypeDisplayName}
      form={form}
      onClose={onClose}
      renderField={(f, value, onChange) => (
        <FieldRenderer
          key={f.key}
          field={f}
          value={value}
          onChange={onChange}
          sshKeyProps={{
            loadKeys: loadSshKeys,
            generateKey: generateSshKey,
            deleteKey: deleteSshKey,
            ...(currentUserId ? { currentUserId } : {}),
          }}
        />
      )}
    />
  );
}

import { KvConsole as SharedKvConsole } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

export function KvConsole({
  accountId,
  driverName,
  pluginId,
  parentResourceId,
}: {
  accountId: string;
  driverName: string;
  pluginId?: string;
  parentResourceId?: string;
}) {
  const orgId = useOrgId();
  return (
    <SharedKvConsole
      driverName={driverName}
      onCommand={async (command, args) => {
        const { result } = await apiPost<{ result: unknown }>(`/api/org/${orgId}/kv/command`, {
          accountId,
          command,
          args,
          ...(pluginId ? { pluginId } : {}),
          ...(parentResourceId ? { parentResourceId } : {}),
        });
        return result;
      }}
    />
  );
}

import { FirestoreDocumentBrowser as SharedFirestoreDocumentBrowser } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

export function FirestoreDocumentBrowser({
  pluginId,
  accountId,
  resourceTypeId,
  resourceId,
  databaseLabel,
  parentResourceId,
}: {
  pluginId: string;
  accountId: string;
  resourceTypeId: string;
  resourceId: string;
  databaseLabel: string;
  parentResourceId?: string;
}) {
  const orgId = useOrgId();
  return (
    <SharedFirestoreDocumentBrowser
      databaseLabel={databaseLabel}
      onCommand={async (command, args) => {
        const { result } = await apiPost<{ result: unknown }>(
          `/api/org/${orgId}/resources/nosql-command`,
          {
            pluginId,
            accountId,
            resourceTypeId,
            resourceId,
            command,
            args,
            ...(parentResourceId ? { parentResourceId } : {}),
          },
        );
        return result;
      }}
    />
  );
}

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
  singleCollection,
}: {
  pluginId: string;
  accountId: string;
  resourceTypeId: string;
  resourceId: string;
  databaseLabel: string;
  parentResourceId?: string;
  singleCollection?: boolean;
}) {
  const orgId = useOrgId();
  return (
    <SharedFirestoreDocumentBrowser
      databaseLabel={databaseLabel}
      singleCollection={singleCollection ?? false}
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

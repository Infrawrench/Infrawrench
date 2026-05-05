import { MongoDocumentBrowser as SharedMongoDocumentBrowser } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

export function MongoDocumentBrowser({
  accountId,
  databaseName,
}: {
  accountId: string;
  databaseName: string;
}) {
  const orgId = useOrgId();
  return (
    <SharedMongoDocumentBrowser
      databaseName={databaseName}
      onCommand={async (command, args) => {
        const { result } = await apiPost<{ result: unknown }>(`/api/org/${orgId}/kv/command`, {
          accountId,
          command,
          args,
        });
        return result;
      }}
    />
  );
}

import { MongoDocumentBrowser as SharedMongoDocumentBrowser } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";

export function MongoDocumentBrowser({
  accountId,
  databaseName,
}: {
  accountId: string;
  databaseName: string;
}) {
  return (
    <SharedMongoDocumentBrowser
      databaseName={databaseName}
      onCommand={async (command, args) => {
        const { result } = await apiPost<{ result: unknown }>("/api/kv/command", {
          accountId,
          command,
          args,
        });
        return result;
      }}
    />
  );
}

import { MongoDocumentBrowser as SharedMongoDocumentBrowser } from "@infrawrench/ui";
import { kvCommand } from "../lib/sql-drivers";

export function MongoDocumentBrowser({ connectionString, databaseName, connected }: { connectionString: string; databaseName: string; connected: boolean }) {
  return (
    <SharedMongoDocumentBrowser
      databaseName={databaseName}
      connected={connected}
      onCommand={async (command, args) => {
        return kvCommand("mongodb", connectionString, command, ...args.map(String));
      }}
    />
  );
}

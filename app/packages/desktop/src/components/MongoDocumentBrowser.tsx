import { MongoDocumentBrowser as SharedMongoDocumentBrowser } from "@infrawrench/ui";
import { kvCommand } from "../lib/sql-drivers";

export function MongoDocumentBrowser({
  driverId,
  connectionString,
  databaseName,
  connected,
}: {
  driverId: string;
  connectionString: string;
  databaseName: string;
  connected: boolean;
}) {
  return (
    <SharedMongoDocumentBrowser
      databaseName={databaseName}
      connected={connected}
      onCommand={async (command, args) => {
        return kvCommand(driverId, connectionString, command, ...args.map(String));
      }}
    />
  );
}

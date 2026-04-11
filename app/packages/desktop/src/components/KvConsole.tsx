import { KvConsole as SharedKvConsole } from "@infrawrench/ui";
import { kvCommand } from "../lib/sql-drivers";

export function KvConsole({
  connectionString,
  driverName,
  connected,
}: {
  connectionString: string;
  driverName: string;
  connected: boolean;
}) {
  return (
    <SharedKvConsole
      driverName={driverName}
      connected={connected}
      onCommand={async (command, args) => {
        return kvCommand(driverName, connectionString, command, ...args.map(String));
      }}
    />
  );
}

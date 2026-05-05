import { KvConsole as SharedKvConsole } from "@infrawrench/ui";
import { kvCommand } from "../lib/sql-drivers";
import { cloudKvCommand } from "../lib/cloud-api";

type LocalMode = {
  mode: "local";
  connectionString: string;
};

type CloudMode = {
  mode: "cloud";
  orgId: string;
  accountId: string;
  pluginId?: string;
  parentResourceId?: string;
};

export function KvConsole({
  driverName,
  connected,
  ...rest
}: {
  driverName: string;
  connected: boolean;
} & (LocalMode | CloudMode)) {
  return (
    <SharedKvConsole
      driverName={driverName}
      connected={connected}
      onCommand={async (command, args) => {
        if (rest.mode === "cloud") {
          const { result } = (await cloudKvCommand(rest.orgId, {
            accountId: rest.accountId,
            command,
            args,
            ...(rest.pluginId ? { pluginId: rest.pluginId } : {}),
            ...(rest.parentResourceId ? { parentResourceId: rest.parentResourceId } : {}),
          })) as { result: unknown };
          return result;
        }
        return kvCommand(driverName, rest.connectionString, command, ...args.map(String));
      }}
    />
  );
}

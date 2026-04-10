import { KvConsole as SharedKvConsole } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";

export function KvConsole({ accountId, driverName }: { accountId: string; driverName: string }) {
  return (
    <SharedKvConsole
      driverName={driverName}
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

import Memjs from "memjs";
import type { KvNodeDriver } from "@infrawrench/plugin-base";

type MemjsClient = InstanceType<typeof Memjs.Client>;

function statsAll(
  client: MemjsClient,
): Promise<{ server: string; stats: Record<string, string> }[]> {
  return new Promise((resolve, reject) => {
    const rows: { server: string; stats: Record<string, string> }[] = [];
    (client as any).stats(
      (err: Error | null, server: string | null, stats: Record<string, string> | null) => {
        if (err) {
          reject(err);
          return;
        }
        if (server === null) {
          resolve(rows);
          return;
        }
        rows.push({ server, stats: stats ?? {} });
      },
    );
  });
}

export const driver = {
  id: "memcached",

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const servers = connectionString.replace(/^memcacheds?:\/\//, "");
    const client = Memjs.Client.create(servers, { timeout: 5, retries: 0 });
    try {
      const a = args.map(String);
      switch (cmd.toUpperCase()) {
        case "GET": {
          const { value } = await client.get(a[0] ?? "");
          return value ? value.toString() : null;
        }
        case "SET": {
          const ok = await client.set(a[0] ?? "", a[1] ?? "", { expires: Number(a[2] ?? 0) });
          return ok ? "STORED" : "NOT STORED";
        }
        case "DELETE":
        case "DEL": {
          const ok = await client.delete(a[0] ?? "");
          return ok ? "DELETED" : "NOT FOUND";
        }
        case "STATS": {
          const results = await statsAll(client);
          return results
            .map(
              ({ server, stats }) =>
                `# ${server}\n` +
                Object.entries(stats)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n"),
            )
            .join("\n\n");
        }
        case "VERSION": {
          const results = await statsAll(client);
          return results
            .map(({ server, stats }) => `${server}: ${stats["version"] ?? "?"}`)
            .join("\n");
        }
        case "FLUSH":
        case "FLUSH_ALL": {
          await client.flush();
          return "OK";
        }
        default:
          throw new Error(`Unknown Memcached command: ${cmd}`);
      }
    } finally {
      client.quit();
    }
  },
} satisfies KvNodeDriver;

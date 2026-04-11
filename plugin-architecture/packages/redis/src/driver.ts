import Redis from "ioredis";
import type { KvNodeDriver } from "@infrawrench/plugin-base";

export const driver = {
  id: "redis",

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const client = new Redis(connectionString, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableReadyCheck: false,
    });
    try {
      await client.connect();
      const fn = (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        cmd.toLowerCase()
      ];
      if (typeof fn !== "function") throw new Error(`Unknown Redis command: ${cmd}`);
      return await fn.call(client, ...args);
    } finally {
      client.disconnect();
    }
  },
} satisfies KvNodeDriver;

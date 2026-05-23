import { Kafka, logLevel, type KafkaConfig, type SASLOptions } from "kafkajs";
import type { KvNodeDriver } from "@infrawrench/plugin-base";

const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 12000;

/**
 * Kafka KV-style node driver.
 *
 * Command protocol:
 *   describeCluster                                       → { clusterId, controller, brokers }
 *   listTopics                                            → string[]
 *   describeTopic         (topicName)                     → { name, partitions: [...] }
 *   createTopic           (name, partitions, replication) → { ok: true }
 *   deleteTopic           (name)                          → { ok: true }
 *   listGroups                                            → [{ groupId, protocolType }]
 *   describeGroup         (groupId)                       → { groupId, state, protocol, members }
 *   fetchOffsets          (groupId)                       → [{ topic, partition, offset, … }]
 *   deleteGroup           (groupId)                       → { ok: true }
 */
function buildKafkaConfig(connectionString: string): KafkaConfig {
  let bootstrap = connectionString;
  let sasl: SASLOptions | undefined;
  let ssl = false;

  try {
    const u = new URL(connectionString);
    const fromQuery = u.searchParams.get("brokers");
    bootstrap = fromQuery || u.host || u.pathname.replace(/^\/+/, "");

    const mechanism = u.searchParams.get("sasl");
    const username =
      u.searchParams.get("user") ?? (u.username ? decodeURIComponent(u.username) : "");
    const password =
      u.searchParams.get("password") ?? (u.password ? decodeURIComponent(u.password) : "");

    if (mechanism) {
      const m = mechanism.toLowerCase();
      if (m === "plain") {
        sasl = { mechanism: "plain", username, password };
      } else if (m === "scram-sha-256") {
        sasl = { mechanism: "scram-sha-256", username, password };
      } else if (m === "scram-sha-512") {
        sasl = { mechanism: "scram-sha-512", username, password };
      } else {
        throw new Error(`Unsupported SASL mechanism: ${mechanism}`);
      }
    } else if (username || password) {
      // Credentials present without an explicit mechanism — default to PLAIN.
      sasl = { mechanism: "plain", username, password };
    }

    const sslParam = u.searchParams.get("ssl");
    ssl = sslParam === "true" || sslParam === "1" || u.protocol === "kafkas:";
  } catch {
    // Fall back to treating the raw string as a broker list.
  }

  const brokers = bootstrap
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (brokers.length === 0) {
    throw new Error("Kafka driver: no bootstrap brokers in connection string");
  }

  const config: KafkaConfig = {
    clientId: "infrawrench",
    brokers,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // kafkajs is chatty by default; suppress its info-level logs.
    logLevel: logLevel.ERROR,
    retry: { retries: 0 },
  };
  if (ssl) config.ssl = true;
  if (sasl) config.sasl = sasl;
  return config;
}

function describeFailure(err: unknown, connectionString: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  let host = "";
  try {
    const u = new URL(connectionString);
    host = u.searchParams.get("brokers") || u.host || "";
  } catch {
    host = connectionString;
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
    return new Error(
      `Cannot connect to Kafka${host ? ` at ${host}` : ""}. Verify the brokers are reachable. ` +
        `For private clusters (AWS MSK, Aiven on private network), bind the account to a bastion.`,
    );
  }
  if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
    return new Error(
      `Cannot resolve Kafka host${host ? ` (${host})` : ""}. Check the connection URL.`,
    );
  }
  if (msg.includes("SASL") || msg.includes("Authentication")) {
    return new Error(`Kafka authentication failed. Check sasl mechanism, user, and password.`);
  }
  return err instanceof Error ? err : new Error(msg);
}

// Reuse admin clients per connection string to avoid the metadata fetch on
// every operation. Idle entries are evicted on a timer.
interface AdminEntry {
  kafka: Kafka;
  admin: ReturnType<Kafka["admin"]>;
  connected: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}
const adminPool = new Map<string, AdminEntry>();
const IDLE_TIMEOUT = 60_000;

function getAdmin(connectionString: string): AdminEntry {
  let entry = adminPool.get(connectionString);
  if (entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return entry;
  }
  const kafka = new Kafka(buildKafkaConfig(connectionString));
  const admin = kafka.admin();
  const connected = admin.connect().catch((err) => {
    // Drop the entry so the next call starts fresh.
    adminPool.delete(connectionString);
    throw describeFailure(err, connectionString);
  });
  entry = { kafka, admin, connected, timer: null };
  adminPool.set(connectionString, entry);
  return entry;
}

function scheduleEviction(connectionString: string) {
  const entry = adminPool.get(connectionString);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    adminPool.delete(connectionString);
    void entry.admin.disconnect().catch(() => {});
  }, IDLE_TIMEOUT);
}

export const driver = {
  id: "kafka",

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const entry = getAdmin(connectionString);
    try {
      await entry.connected;
      const admin = entry.admin;

      switch (cmd) {
        case "describeCluster": {
          return await admin.describeCluster();
        }

        case "listTopics": {
          return await admin.listTopics();
        }

        case "describeTopic": {
          const name = String(args[0] ?? "");
          if (!name) throw new Error("describeTopic requires a topic name");
          const meta = await admin.fetchTopicMetadata({ topics: [name] });
          return meta.topics[0] ?? null;
        }

        case "createTopic": {
          const name = String(args[0] ?? "");
          if (!name) throw new Error("createTopic requires a name");
          const numPartitions = Number(args[1] ?? 1);
          const replicationFactor = Number(args[2] ?? 1);
          await admin.createTopics({
            topics: [{ topic: name, numPartitions, replicationFactor }],
            waitForLeaders: true,
          });
          return { ok: true };
        }

        case "deleteTopic": {
          const name = String(args[0] ?? "");
          if (!name) throw new Error("deleteTopic requires a name");
          await admin.deleteTopics({ topics: [name] });
          return { ok: true };
        }

        case "listGroups": {
          const result = await admin.listGroups();
          return result.groups;
        }

        case "describeGroup": {
          const groupId = String(args[0] ?? "");
          if (!groupId) throw new Error("describeGroup requires a groupId");
          const result = await admin.describeGroups([groupId]);
          return result.groups[0] ?? null;
        }

        case "fetchOffsets": {
          const groupId = String(args[0] ?? "");
          if (!groupId) throw new Error("fetchOffsets requires a groupId");
          return await admin.fetchOffsets({ groupId });
        }

        case "deleteGroup": {
          const groupId = String(args[0] ?? "");
          if (!groupId) throw new Error("deleteGroup requires a groupId");
          await admin.deleteGroups([groupId]);
          return { ok: true };
        }

        default:
          throw new Error(`Kafka driver: unknown command "${cmd}"`);
      }
    } catch (err) {
      throw describeFailure(err, connectionString);
    } finally {
      scheduleEviction(connectionString);
    }
  },
} satisfies KvNodeDriver;

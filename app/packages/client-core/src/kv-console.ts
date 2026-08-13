/**
 * Pure pieces of the KV console — command tokenizing, result formatting, and
 * the per-driver copy. Web, desktop and mobile all render this console, so the
 * parsing lives here and each host only supplies the widgets.
 */

/** One echoed line in the console transcript, on every surface. */
export interface KvConsoleLine {
  kind: "input" | "output" | "error";
  text: string;
}

export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function formatRedisResult(value: unknown): string {
  if (value === null) return "(nil)";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map((v, i) => `${i + 1}) ${formatRedisResult(v)}`).join("\n");
  }
  return JSON.stringify(value);
}

/**
 * Split a console line into the `{ command, args }` pair the `/kv/command`
 * endpoint expects. Numeric-looking arguments are sent as numbers, which is
 * what the Redis and Memcached drivers want for counts and TTLs.
 */
export function parseKvCommand(raw: string): { command: string; args: (string | number)[] } {
  const [cmd, ...args] = tokenize(raw.trim());
  return {
    command: cmd ?? "",
    args: args.map((a) => (isNaN(Number(a)) ? a : Number(a))),
  };
}

export interface KvConsoleProfile {
  /** Title shown in the console header, e.g. "Redis Console". */
  label: string;
  /** Example commands shown in the empty state. */
  examples: string;
  /** Greyed-out input placeholder when idle. */
  placeholder: string;
}

// Per-driver console copy so the panel reflects the actual datastore instead of
// always saying "Redis". The command set differs per driver (the Kafka driver
// takes Admin ops, Mongo takes operation names), so the examples differ too.
const CONSOLE_PROFILES: Record<string, KvConsoleProfile> = {
  redis: { label: "Redis", examples: "PING, KEYS *, GET mykey", placeholder: "PING" },
  memcached: {
    label: "Memcached",
    examples: "STATS, get key, set key 0 0 3",
    placeholder: "STATS",
  },
  mongodb: {
    label: "MongoDB",
    examples: "listDatabases, dbStats, serverVersion",
    placeholder: "listDatabases",
  },
  kafka: {
    label: "Kafka",
    examples: "listTopics, describeCluster, describeTopic <name>",
    placeholder: "listTopics",
  },
};

export function kvConsoleProfile(driverName: string): KvConsoleProfile {
  return (
    CONSOLE_PROFILES[driverName] ?? {
      label: driverName ? driverName.charAt(0).toUpperCase() + driverName.slice(1) : "Console",
      examples: "type a command and press Enter",
      placeholder: "command",
    }
  );
}

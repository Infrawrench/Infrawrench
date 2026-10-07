/**
 * How the plugin client hands a NATS connection to the node driver.
 *
 * The host gives a kv driver exactly one credential, the connection string
 * (here: the `servers` field, so the SSH-tunnel rewriter and the cloud egress
 * guard both see the server list). NATS authenticates with several other
 * values (user/password, token, an NKey seed, a JWT `.creds` file, TLS
 * material), so the client prepends them to every command as one argument:
 * `natsauth:` + JSON. A command without it (the host's KV console) connects
 * with whatever auth the server URL itself carries (`nats://user:pass@host`
 * or `nats://token@host`).
 *
 * Every value is content, never a path: the driver runs in a shared cloud
 * process, so it must not read files named by a tenant.
 *
 * Pure module: imported by both the browser-safe client and the node driver.
 */
import { hostPortDialTarget, type DialTarget } from "@infrawrench/plugin-base";

export const AUTH_PREFIX = "natsauth:";

export interface NatsAuth {
  /** Username (with `pass`). */
  user?: string;
  pass?: string;
  token?: string;
  /** NKey seed, the `SU...` line of an nk file. */
  nkeySeed?: string;
  /** Contents of a decorated `.creds` file (user JWT + NKey seed). */
  creds?: string;
  /** PEM trust anchor for the server certificate. */
  ca?: string;
  /** PEM client certificate and key, for servers with `verify: true`. */
  cert?: string;
  key?: string;
  /** TLS server name, for a server reached through a tunnel on 127.0.0.1. */
  servername?: string;
}

const AUTH_KEYS: Array<keyof NatsAuth> = [
  "user",
  "pass",
  "token",
  "nkeySeed",
  "creds",
  "ca",
  "cert",
  "key",
  "servername",
];

/** The credential field each auth value comes from. */
export const CREDENTIAL_FOR: Record<keyof NatsAuth, string> = {
  user: "natsUser",
  pass: "natsPassword",
  token: "natsToken",
  nkeySeed: "nkeySeed",
  creds: "credsFile",
  ca: "caCert",
  cert: "clientCert",
  key: "clientKey",
  servername: "tlsServerName",
};

export function authFromCredentials(credentials: Record<string, string>): NatsAuth {
  const out: NatsAuth = {};
  for (const k of AUTH_KEYS) {
    const v = credentials[CREDENTIAL_FOR[k]];
    // Passwords and PEM blocks keep their whitespace; only blank values drop.
    if (typeof v === "string" && v.trim()) out[k] = k === "pass" ? v : v.trim();
  }
  return out;
}

export function encodeAuth(auth: NatsAuth): string {
  return AUTH_PREFIX + JSON.stringify(auth);
}

/** Split `args` into the auth envelope (when the first argument is one) and the rest. */
export function decodeAuthArgs(args: readonly (string | number)[]): {
  auth: NatsAuth;
  rest: string[];
  keyed: string;
} {
  const first = args[0];
  if (typeof first === "string" && first.startsWith(AUTH_PREFIX)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(first.slice(AUTH_PREFIX.length));
    } catch {
      throw new Error("NATS driver: malformed auth argument");
    }
    const auth: NatsAuth = {};
    if (parsed && typeof parsed === "object")
      for (const k of AUTH_KEYS) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === "string" && v) auth[k] = v;
      }
    return { auth, rest: args.slice(1).map(String), keyed: first };
  }
  return { auth: {}, rest: args.map(String), keyed: "" };
}

export interface ParsedServer {
  /** `host:port` handed to nats.js (scheme and userinfo removed). */
  hostPort: string;
  host: string;
  port: number;
  tls: boolean;
  user?: string;
  pass?: string;
}

/**
 * `nats://a:4222, tls://user:pw@b` → one entry per server. A bare `host`
 * gets port 4222. Userinfo is pulled out so it can become auth instead of
 * reaching nats.js (which drops it).
 */
export function parseServers(raw: string): ParsedServer[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(token);
      const scheme = m ? m[1]!.toLowerCase() : "nats";
      let rest = (m ? m[2]! : token).replace(/\/.*$/, "");
      let user: string | undefined;
      let pass: string | undefined;
      const at = rest.lastIndexOf("@");
      if (at !== -1) {
        const info = rest.slice(0, at);
        rest = rest.slice(at + 1);
        const colon = info.indexOf(":");
        user = decodeURIComponent(colon === -1 ? info : info.slice(0, colon));
        if (colon !== -1) pass = decodeURIComponent(info.slice(colon + 1));
      }
      const target = hostPortDialTarget(rest, 4222);
      const host = target.kind === "host" ? target.host : rest;
      const port = target.kind === "host" ? target.port : 4222;
      return {
        hostPort: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`,
        host,
        port,
        tls: scheme === "tls",
        ...(user !== undefined ? { user } : {}),
        ...(pass !== undefined ? { pass } : {}),
      };
    });
}

/**
 * Every address the driver dials. nats.js is told to ignore the cluster's
 * gossiped `connect_urls`, so this list is complete.
 */
export function natsDialTargets(raw: string): DialTarget[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(token);
      if (m && !["nats", "tls"].includes(m[1]!.toLowerCase()))
        return { kind: "local", reason: `unsupported NATS URL scheme "${m[1]}"` } as DialTarget;
      return hostPortDialTarget((m ? m[2]! : token).replace(/\/.*$/, ""), 4222);
    });
}

/** A human list of the servers, credentials stripped, for error messages. */
export function describeServers(raw: string): string {
  return parseServers(raw)
    .map((s) => s.hostPort)
    .join(", ");
}

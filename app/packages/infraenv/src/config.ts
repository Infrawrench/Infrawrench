/**
 * Who `infraenv` talks to Infrawrench as, and in which organization.
 *
 * Credentials, first match wins:
 * 1. `INFRAWRENCH_API_KEY` (an `iwk_` key): CI, or anyone who keeps keys in
 *    their shell.
 * 2. The key `infraenv login` stored in `infraenv.json` under the user's
 *    config directory (`$XDG_CONFIG_HOME/infrawrench`, `~/.config/infrawrench`,
 *    or `%APPDATA%\infrawrench` on Windows), mode 0600.
 *
 * The API origin is `INFRAWRENCH_BASE_URL`, else the one the stored key was
 * checked against, else https://app.infrawrench.com.
 *
 * An API key is pinned to one organization, and `GET /api/v1/whoami` says
 * which, so the organization never has to be typed. It is, first match wins:
 * `--org`, `INFRAWRENCH_ORG_ID` (or the desktop CLI's `INFRAWRENCH_ORG`), the
 * file's `[infrawrench] org`, the organization `login` stored with the key,
 * and otherwise the key's own organization as whoami reports it.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseOrgIdInput } from "@infrawrench/client-core";
import type { Io } from "./io";
import { Failure } from "./io";

export const DEFAULT_BASE_URL = "https://app.infrawrench.com";

export interface StoredCredentials {
  readonly apiKey: string;
  /** The key's organization, as whoami reported it at login. */
  readonly orgId?: string | undefined;
  /** The origin the key was checked against, when it was not the default. */
  readonly baseUrl?: string | undefined;
}

export interface Credentials {
  readonly apiKey: string;
  readonly source: "env" | "stored";
  readonly baseUrl: string;
  /** The organization stored with the key; null for a key from the environment. */
  readonly storedOrg: string | null;
}

/** Where `login` keeps the key. */
export function configPath(io: Pick<Io, "env" | "home" | "platform">): string {
  const { env } = io;
  if (io.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "infrawrench", "infraenv.json");
  }
  const base = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : join(io.home, ".config");
  return join(base, "infrawrench", "infraenv.json");
}

export function readStored(path: string): StoredCredentials | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.apiKey !== "string" || value.apiKey === "") return null;
    return {
      apiKey: value.apiKey,
      orgId: typeof value.orgId === "string" ? value.orgId : undefined,
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : undefined,
    };
  } catch {
    throw new Failure(`${path} is not valid JSON. Run \`infraenv logout\`, then log in again.`);
  }
}

/** Write the stored key with mode 0600 (directory 0700), atomically. */
export function writeStored(path: string, credentials: StoredCredentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeSecretFile(path, `${JSON.stringify(credentials, null, 2)}\n`);
}

export function deleteStored(path: string): boolean {
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

/**
 * Write `text` to `path` with mode 0600, atomically: a temporary file beside
 * it renamed over it, so a reader never sees half a file and an existing
 * file's wider mode never survives.
 */
export function writeSecretFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Failure(`INFRAWRENCH_BASE_URL is not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Failure(`INFRAWRENCH_BASE_URL must be http(s), not ${url.protocol}`);
  }
  return trimmed;
}

/** The key to use and where it came from, or null when there is none. */
export function findCredentials(
  env: Io["env"],
  stored: StoredCredentials | null,
): Credentials | null {
  const fromEnv = env.INFRAWRENCH_API_KEY?.trim();
  const envBase = env.INFRAWRENCH_BASE_URL?.trim();
  if (fromEnv) {
    return {
      apiKey: fromEnv,
      source: "env",
      baseUrl: normalizeBaseUrl(envBase || DEFAULT_BASE_URL),
      storedOrg: null,
    };
  }
  if (stored) {
    return {
      apiKey: stored.apiKey,
      source: "stored",
      baseUrl: normalizeBaseUrl(envBase || stored.baseUrl || DEFAULT_BASE_URL),
      storedOrg: stored.orgId ?? null,
    };
  }
  return null;
}

export type OrgSource = "flag" | "env" | "file" | "login" | "key";

export interface OrgChoice {
  readonly id: string;
  readonly from: OrgSource;
}

/**
 * The organization to resolve in, without asking the server: null means
 * "the key's own", which the caller learns from whoami.
 */
export function chooseOrg(input: {
  readonly flag: string | null;
  readonly env: Io["env"];
  readonly file: string | null | undefined;
  readonly credentials: Credentials;
}): OrgChoice | null {
  const flag = input.flag?.trim();
  if (flag) return { id: orgIdFrom(flag, "--org"), from: "flag" };
  const env = (input.env.INFRAWRENCH_ORG_ID ?? input.env.INFRAWRENCH_ORG)?.trim();
  if (env) return { id: orgIdFrom(env, "INFRAWRENCH_ORG_ID"), from: "env" };
  const file = input.file?.trim();
  if (file) return { id: file, from: "file" };
  if (input.credentials.storedOrg) return { id: input.credentials.storedOrg, from: "login" };
  return null;
}

/** An organization id, or one pulled out of a pasted Infrawrench web address. */
export function orgIdFrom(input: string, what: string): string {
  const id = parseOrgIdInput(input);
  if (id === null) {
    throw new Failure(
      `${what} must be an organization id (or an Infrawrench web address containing /org/<id>/), not ${JSON.stringify(input)}`,
    );
  }
  return id;
}

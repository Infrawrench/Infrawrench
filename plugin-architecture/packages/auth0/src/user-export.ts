import {
  hostFetch,
  ListTruncatedError,
  pathEncode,
  reportUnreadListPart,
  type ApiBody,
  type ApiClient,
  type HostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";
import type { A0Job, A0User } from "./types.js";

/**
 * Listing a tenant's users past the 1,000 its search returns, through Auth0's bulk
 * export (https://auth0.com/docs/manage-users/user-migration/bulk-user-exports).
 *
 * Auth0 says not to enumerate users through the search, and partitioning it by
 * `created_at` would still spend one request per 100 users against a tenant's rate
 * limit, on an index it calls unsuitable for correctness-critical reads. A sync prunes
 * by what a list returns, so it needs the export: a few requests whatever the size.
 *
 * A job can outlast a poll and Auth0 allows ten at a time, so the job's id has to
 * survive to the next poll, which may run elsewhere. The search's newest rows are still
 * read every poll, and between exports the older rows stay as stored.
 */

const PATH = "/jobs/users-exports";

/** The most rows a list that goes through the resource sync may hold. */
const MAX_USERS = 100_000;

const EXPORT_EVERY_MS = 6 * 60 * 60 * 1000;

/** Long enough for a tenant in the low thousands to fill on its first sync. */
const WAIT_FOR_NEW_JOB_MS = 60_000;
const WAIT_STEP_MS = 5_000;

/** Stored on the tenant's row: the only store that outlives a poll is the secret one. */
const STATE_FIELD = "usersExportJob";

/**
 * A user the search still returns, who was there before the export began, can only be
 * missing from it through a race with the index. More than this many means the file is
 * not what it should be, and pruning by it would delete the rest.
 */
const MAX_MISSING_SHARE = 0.01;

const EVERY_ROW = { idPrefixes: [""] };

const REQUEST = {
  format: "json",
  // The document's schema gives this a default of 5, and its guide says all of them.
  limit: MAX_USERS + 1,
  fields: [
    { name: "user_id" },
    { name: "email" },
    { name: "name" },
    { name: "nickname" },
    { name: "email_verified" },
    { name: "blocked" },
    { name: "identities[0].connection", export_as: "connection" },
    { name: "logins_count" },
    { name: "last_login" },
    { name: "last_ip" },
    { name: "created_at" },
    { name: "updated_at" },
  ],
} satisfies ApiBody<operations["post_users-exports"]>;

interface ExportState {
  jobId: string;
  startedAt: number;
  /** When its rows were read or it failed. The next export is due from this. */
  doneAt?: number;
  overCap?: boolean;
}

/** A user as read from an export line, in the search's spelling. */
export interface ExportedUser {
  user_id: string;
  email?: string;
  name?: string;
  nickname?: string;
  email_verified: boolean;
  blocked: boolean;
  identities: { connection?: string }[];
  logins_count?: number;
  last_login?: string;
  last_ip?: string;
  created_at?: string;
  updated_at?: string;
}

/** Export lines are not validated, and the document does not describe them. */
type Field = string | number | boolean | object | null | undefined;
interface ExportLine {
  user_id?: Field;
  email?: Field;
  name?: Field;
  nickname?: Field;
  email_verified?: Field;
  blocked?: Field;
  connection?: Field;
  "identities[0].connection"?: Field;
  identities?: { connection?: Field }[];
  logins_count?: Field;
  last_login?: Field;
  last_ip?: Field;
  created_at?: Field;
  updated_at?: Field;
}

export interface UserExportHost {
  rest: ApiClient<paths>;
  services: HostServices | undefined;
  caCert: string;
  /** The tenant's row, which the job's id is stored against. */
  stateResourceId: string;
}

function text(value: Field): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function flag(value: Field): boolean {
  return value === true || value === "true";
}

function count(value: Field): number | undefined {
  const parsed = typeof value === "string" && value !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function hasStatus(err: unknown, ...statuses: number[]): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number" &&
    statuses.includes(err.status)
  );
}

function readState(stored: string | null): ExportState | undefined {
  if (!stored) return undefined;
  try {
    const state: ExportState = JSON.parse(stored);
    return typeof state.jobId === "string" && state.jobId ? state : undefined;
  } catch {
    return undefined;
  }
}

function toUser(line: ExportLine): ExportedUser | undefined {
  const id = text(line.user_id);
  if (!id) return undefined;
  const connection =
    text(line.connection) ??
    text(line["identities[0].connection"]) ??
    text(line.identities?.[0]?.connection);
  const logins = count(line.logins_count);
  const optional = {
    email: text(line.email),
    name: text(line.name),
    nickname: text(line.nickname),
    last_login: text(line.last_login),
    last_ip: text(line.last_ip),
    created_at: text(line.created_at),
    updated_at: text(line.updated_at),
  };
  return {
    user_id: id,
    email_verified: flag(line.email_verified),
    blocked: flag(line.blocked),
    identities: connection ? [{ connection }] : [],
    ...(logins !== undefined ? { logins_count: logins } : {}),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}

async function* linesOf(res: Response): AsyncGenerator<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = new Blob([bytes]).stream();
  // A transport that honours a `Content-Encoding` has already undone the gzip.
  const zipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const reader = (zipped ? body.pipeThrough(new DecompressionStream("gzip")) : body)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let partial = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (partial + value).split("\n");
      partial = lines.pop() ?? "";
      yield* lines;
    }
    if (partial) yield partial;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The file's users by id, or undefined past {@link MAX_USERS}. The URL is signed, so it stays out of every message. */
async function readFile(
  host: UserExportHost,
  location: string,
): Promise<Map<string, A0User | ExportedUser> | undefined> {
  if (new URL(location).protocol !== "https:") {
    throw new Error("Auth0 plugin: the user export's location is not https");
  }
  const res = await hostFetch({ http: host.services?.http, caCert: host.caCert }, location);
  if (!res.ok) throw new Error(`Auth0 plugin: downloading the user export answered ${res.status}`);
  const users = new Map<string, A0User | ExportedUser>();
  for await (const raw of linesOf(res)) {
    if (!raw.trim()) continue;
    const line: ExportLine = JSON.parse(raw);
    const user = toUser(line);
    if (!user) continue;
    users.set(user.user_id, user);
    if (users.size > MAX_USERS) return undefined;
  }
  return users;
}

function matchesSearch(
  newest: A0User[],
  exported: Map<string, A0User | ExportedUser>,
  startedAt: number,
): boolean {
  if (exported.size === 0) return false;
  const expected = newest.filter(
    ({ created_at }) => typeof created_at === "string" && Date.parse(created_at) < startedAt,
  );
  const missing = expected.filter((u) => typeof u.user_id !== "string" || !exported.has(u.user_id));
  return missing.length <= expected.length * MAX_MISSING_SHARE;
}

function overCap(): ListTruncatedError {
  return new ListTruncatedError({
    vendor: "Auth0",
    path: PATH,
    items: MAX_USERS,
    maxItems: MAX_USERS,
  });
}

/**
 * Every user of a tenant whose search stopped at `newest`. Answers `newest` alone when
 * the export has nothing to add yet and the host keeps the stored rows of a list that
 * says it left them unread. Throws where it would otherwise say something false.
 */
export async function usersPastSearch(
  host: UserExportHost,
  newest: A0User[],
): Promise<(A0User | ExportedUser)[]> {
  const { rest, stateResourceId } = host;
  const secrets = host.services?.secrets;
  if (!secrets?.setPlaintext) {
    throw new ListTruncatedError({
      vendor: "Auth0",
      path: "/users",
      items: newest.length,
      maxItems: newest.length,
    });
  }
  const save = async (state: ExportState) => {
    await secrets.setPlaintext?.(stateResourceId, STATE_FIELD, JSON.stringify(state));
  };

  const state = readState(await secrets.getPlaintext(stateResourceId, STATE_FIELD));
  const recent = state?.doneAt !== undefined && Date.now() - state.doneAt < EXPORT_EVERY_MS;
  if (recent && state?.overCap) throw overCap();
  if (recent && reportUnreadListPart(EVERY_ROW)) return newest;

  const readJob = async (id: string): Promise<A0Job | undefined> => {
    try {
      return await rest.get(`/jobs/${pathEncode(id)}`);
    } catch (err) {
      if (hasStatus(err, 404)) return undefined;
      throw err;
    }
  };

  /** Read the job until it ends or the wait runs out. */
  const awaitNewJob = async (id: string): Promise<A0Job> => {
    const deadline = Date.now() + WAIT_FOR_NEW_JOB_MS;
    for (;;) {
      const job: A0Job = await rest.get(`/jobs/${pathEncode(id)}`);
      if (job.status === "completed" || job.status === "failed" || Date.now() >= deadline) {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
  };

  try {
    let current = state && (recent || state.doneAt === undefined) ? state : undefined;
    let job = current && (await readJob(current.jobId));
    if (!current || !job) {
      const created = await rest.post(PATH, { body: REQUEST });
      if (!created.id) throw new Error("Auth0 plugin: the user export answered no job id");
      current = { jobId: created.id, startedAt: Date.now() };
      await save(current);
      job = await awaitNewJob(created.id);
    }

    // Reading an export again, on a host that keeps no rows, does not make it any newer.
    const finish = async (result: { overCap?: boolean } = {}) => {
      if (current && current.doneAt === undefined) {
        await save({ ...current, doneAt: Date.now(), ...result });
      }
    };

    if (job.status === "failed") {
      await finish();
      throw new Error(`Auth0 plugin: the user export failed: ${job.status_details ?? "no detail"}`);
    }
    if (job.status !== "completed") {
      if (reportUnreadListPart(EVERY_ROW)) return newest;
      const progress =
        typeof job.percentage_done === "number" ? ` (${job.percentage_done}% done)` : "";
      throw new Error(
        `Auth0 is still exporting this tenant's users${progress}, because it has more than the 1,000 its search returns. Try again in a few minutes.`,
      );
    }
    if (!job.location) throw new Error("Auth0 plugin: the finished user export has no location");

    const exported = await readFile(host, job.location);
    if (!exported) {
      await finish({ overCap: true });
      throw overCap();
    }
    if (!matchesSearch(newest, exported, current.startedAt)) {
      await finish();
      throw new Error(
        "Auth0 plugin: the user export does not match what the user search returns, so it was not used. The users already listed stay.",
      );
    }
    for (const user of newest) {
      if (typeof user.user_id === "string" && user.user_id) exported.set(user.user_id, user);
    }
    if (exported.size > MAX_USERS) {
      await finish({ overCap: true });
      throw overCap();
    }
    await finish();
    return [...exported.values()];
  } catch (err) {
    // The search answered, so this is the plan (the guide says the Free plan has no
    // exports) or a credential with `read:users` alone, which the job read may refuse.
    if (!hasStatus(err, 402, 403)) throw err;
    if (!reportUnreadListPart(EVERY_ROW)) throw err;
    return newest;
  }
}

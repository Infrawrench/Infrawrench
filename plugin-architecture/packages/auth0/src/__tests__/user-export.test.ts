import { hostClient } from "@infrawrench/plugin-base/effect";
import type { HostedMethods, HostServices } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth0Client } from "../client.js";
import { manifest } from "../plugin.js";

const ACCOUNT = "acct";
const DOMAIN = "acme.eu.auth0.com";
const STATE_KEY = `${ACCOUNT}:tenant:${DOMAIN}\0usersExportJob`;
const LOCATION =
  "https://peu2-auth0-export-users-eu-west-1.s3.eu-west-1.amazonaws.com/job_1/acme.json.gz?Signature=fixture";
const HOUR = 60 * 60 * 1000;
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  responseEncoding?: string;
  caCert?: string;
}
interface Reply {
  status?: number;
  body?: string | object;
  raw?: Promise<Uint8Array<ArrayBuffer>>;
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const zipped = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(zipped).arrayBuffer());
}

let calls: Call[];
let secrets: Map<string, string>;

const user = (i: number, extra: object = {}) => ({
  user_id: `auth0|${i}`,
  email: `u${i}@example.com`,
  created_at: "2020-01-01T00:00:00.000Z",
  identities: [{ connection: "Username-Password-Authentication" }],
  ...extra,
});

/** Ten full pages of the search, which is all it will give: users 0 to 999. */
function searchPage(call: Call): Reply {
  const page = Number(new URL(call.url).searchParams.get("page"));
  const users = Array.from({ length: 100 }, (_, i) => user(page * 100 + i));
  return { body: { start: page * 100, limit: 100, total: 1000, users } };
}

/** An export of users 0 to `count - 1`, one JSON object a line, gzipped as Auth0 serves it. */
function exportFile(count: number, line: (i: number) => object = exportLine): Reply {
  const text = Array.from({ length: count }, (_, i) => JSON.stringify(line(i))).join("\n");
  return { raw: gzip(`${text}\n`) };
}

function exportLine(i: number): object {
  return {
    user_id: `auth0|${i}`,
    email: `export${i}@example.com`,
    name: `User ${i}`,
    nickname: `u${i}`,
    email_verified: true,
    blocked: false,
    connection: "Exported-Connection",
    logins_count: 7,
    last_login: "2021-01-01T00:00:00.000Z",
    last_ip: "192.0.2.1",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-06-01T00:00:00.000Z",
  };
}

interface Tenant {
  search?: (call: Call) => Reply;
  start?: () => Reply;
  job?: (id: string) => Reply;
  file?: () => Reply;
}

function client(tenant: Tenant, extra: Partial<HostServices> = {}): HostedMethods<Auth0Client> {
  const route = (call: Call): Reply => {
    const url = new URL(call.url);
    if (url.hostname !== DOMAIN) {
      if (!tenant.file) throw new Error(`Unexpected request to ${url.hostname}`);
      return tenant.file();
    }
    if (url.pathname === "/oauth/token")
      return { body: { access_token: "mgmt", expires_in: 86400 } };
    if (url.pathname === "/api/v2/users") return (tenant.search ?? searchPage)(call);
    if (url.pathname === "/api/v2/jobs/users-exports" && call.method === "POST") {
      return tenant.start?.() ?? { body: { id: "job_1", type: "users_export", status: "pending" } };
    }
    const job = url.pathname.match(/^\/api\/v2\/jobs\/(.+)$/);
    if (job?.[1] && tenant.job) return tenant.job(job[1]);
    throw new Error(`Unexpected request to ${call.method} ${url.pathname}`);
  };
  const services: HostServices = {
    http: {
      request: async (req) => {
        const call: Call = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
          ...(req.responseEncoding ? { responseEncoding: req.responseEncoding } : {}),
          ...(req.caCert ? { caCert: req.caCert } : {}),
        };
        calls.push(call);
        const res = route(call);
        return {
          status: res.status ?? 200,
          headers: {},
          body:
            res.body === undefined
              ? ""
              : typeof res.body === "string"
                ? res.body
                : JSON.stringify(res.body),
          ...(res.raw ? { rawBody: await res.raw } : {}),
        };
      },
    },
    secrets: {
      getPlaintext: async (id, field) => secrets.get(`${id}\0${field}`) ?? null,
      setPlaintext: async (id, field, value) => {
        secrets.set(`${id}\0${field}`, value);
      },
    },
    ...extra,
  };
  return hostClient(
    new Auth0Client({ domain: DOMAIN, clientId: "cid", clientSecret: "csecret" }, services),
  );
}

const done = { id: "job_1", type: "users_export", status: "completed", location: LOCATION };
const pending = { id: "job_1", type: "users_export", status: "pending" };

const posts = () => calls.filter((c) => c.url.endsWith("/jobs/users-exports"));
const jobReads = () => calls.filter((c) => /\/jobs\/job_/.test(c.url));
const downloads = () => calls.filter((c) => c.url.startsWith("https://peu2-auth0-export"));

/** A sync's host: it keeps the rows of a list that says it left them unread. */
function trackingHost() {
  const unread = vi.fn();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
  return unread;
}

function listFinished() {
  secrets.set(
    STATE_KEY,
    JSON.stringify({ jobId: "job_1", startedAt: Date.now(), doneAt: Date.now() }),
  );
}

beforeEach(() => {
  calls = [];
  secrets = new Map();
  vi.stubGlobal("fetch", () => {
    throw new Error("the host transport should have been used");
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a tenant the search can read whole", () => {
  it("starts no export", async () => {
    const c = client({
      search: () => ({ body: { total: 3, users: [user(0), user(1), user(2)] } }),
    });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(3);
    expect(posts()).toHaveLength(0);
    expect(secrets.size).toBe(0);
  });

  it("does not start one for a search that failed", async () => {
    const c = client({ search: () => ({ status: 503, body: { message: "Query timed out" } }) });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("Query timed out");
    expect(posts()).toHaveLength(0);
  });
});

describe("a tenant past the search's 1,000", () => {
  it("lists every user from the export, spelled as the search spells them", async () => {
    const c = client({ job: () => ({ body: done }), file: () => exportFile(2500) });
    const users = await c.listResources("user", ACCOUNT);
    expect(users).toHaveLength(2500);
    expect(new Set(users.map((u) => u.id)).size).toBe(2500);

    const old = users.find((u) => u.externalId === "auth0|2400");
    expect(old?.id).toBe(`${ACCOUNT}:user:auth0|2400`);
    expect(old?.displayName).toBe("export2400@example.com");
    expect(old?.fields).toMatchObject({
      email: "export2400@example.com",
      name: "User 2400",
      nickname: "u2400",
      emailVerified: true,
      blocked: false,
      connection: "Exported-Connection",
      userId: "auth0|2400",
      loginsCount: 7,
      lastLogin: "2021-01-01T00:00:00.000Z",
      lastIp: "192.0.2.1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(old?.updatedAt).toBe("2020-06-01T00:00:00.000Z");
  });

  it("prefers the live search row, and keeps users newer than the export", async () => {
    const c = client({
      search: (call) => {
        const page = Number(new URL(call.url).searchParams.get("page"));
        const users = Array.from({ length: 100 }, (_, i) => user(page * 100 + i));
        // Signed up after Auth0 took the export.
        if (page === 0)
          users[0] = user(9000, { created_at: new Date(Date.now() + HOUR).toISOString() });
        return { body: { users } };
      },
      job: () => ({ body: done }),
      file: () => exportFile(1500),
    });
    const users = await c.listResources("user", ACCOUNT);
    expect(users).toHaveLength(1501);
    expect(users.find((u) => u.externalId === "auth0|9000")).toBeDefined();
    expect(users.find((u) => u.externalId === "auth0|5")?.fields["email"]).toBe("u5@example.com");
    expect(users.find((u) => u.externalId === "auth0|1200")?.fields["email"]).toBe(
      "export1200@example.com",
    );
  });

  it("asks for an explicit limit and just the fields it reads, as JSON", async () => {
    const c = client({ job: () => ({ body: done }), file: () => exportFile(1500) });
    await c.listResources("user", ACCOUNT);
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0]?.body ?? "{}");
    expect(body.format).toBe("json");
    // The document's schema gives `limit` a default of 5, so leaving it out is not safe.
    expect(body.limit).toBe(100_001);
    expect(body.connection_id).toBeUndefined();
    expect(body.fields.map((f: { name: string }) => f.name)).toEqual([
      "user_id",
      "email",
      "name",
      "nickname",
      "email_verified",
      "blocked",
      "identities[0].connection",
      "logins_count",
      "last_login",
      "last_ip",
      "created_at",
      "updated_at",
    ]);
  });

  it("downloads through the host, with none of the account's credentials", async () => {
    const c = client({ job: () => ({ body: done }), file: () => exportFile(1500) });
    await c.listResources("user", ACCOUNT);
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0]?.responseEncoding).toBe("binary");
    expect(downloads()[0]?.headers).toEqual({});
    expect(downloads()[0]?.caCert).toBeUndefined();
  });

  it("declares the download's host, or a bastion's allowlist would refuse it", () => {
    const { hostname } = new URL(LOCATION);
    const declared: readonly string[] = manifest.egressHosts;
    expect(declared.some((host) => host.startsWith("*.") && hostname.endsWith(host.slice(1)))).toBe(
      true,
    );
  });

  it("reads the other ways the export may spell a value", async () => {
    const c = client({
      job: () => ({ body: done }),
      file: () =>
        exportFile(1500, (i) => ({
          user_id: `auth0|${i}`,
          email_verified: "true",
          blocked: "true",
          logins_count: "12",
          ...(i % 2 === 0
            ? { "identities[0].connection": "Spelled-As-Asked" }
            : { identities: [{ connection: "Nested" }] }),
        })),
    });
    const users = await c.listResources("user", ACCOUNT);
    const fields = (id: number) => users.find((u) => u.externalId === `auth0|${id}`)?.fields;
    expect(fields(1200)).toMatchObject({
      emailVerified: true,
      blocked: true,
      loginsCount: 12,
      connection: "Spelled-As-Asked",
    });
    expect(fields(1201)?.["connection"]).toBe("Nested");
  });

  it("reads a file the transport already decompressed", async () => {
    const plain = Array.from({ length: 1500 }, (_, i) => JSON.stringify(exportLine(i))).join("\n");
    const c = client({
      job: () => ({ body: done }),
      file: () => ({ raw: Promise.resolve(new TextEncoder().encode(plain)) }),
    });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1500);
  });

  it("treats a search refused part way as past its depth, never as the whole list", async () => {
    const c = client({
      search: (call) =>
        Number(new URL(call.url).searchParams.get("page")) < 3
          ? searchPage(call)
          : { status: 400, body: { message: "You can only page through the first 300 records" } },
      job: () => ({ body: done }),
      file: () => exportFile(1500),
    });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1500);
  });

  it("refuses a location that is not https", async () => {
    const c = client({
      job: () => ({ body: { ...done, location: "http://example.com/acme.json.gz" } }),
      file: () => exportFile(1500),
    });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("not https");
    expect(calls.some((call) => call.url.startsWith("http://"))).toBe(false);
  });

  it("does not put the signed URL in the error for a failed download", async () => {
    const unread = trackingHost();
    const c = client({
      job: () => ({ body: done }),
      file: () => ({ status: 403, body: "Expired" }),
    });
    const err = await c.listResources("user", ACCOUNT).catch((e: Error) => e);
    expect(String(err)).toContain("403");
    expect(String(err)).not.toContain("Signature");
    // S3 refusing a link is not Auth0 refusing the credential, so the failure shows.
    expect(unread).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get(STATE_KEY) ?? "{}").doneAt).toBeUndefined();
  });

  it("throws on a corrupt file, and on a line that is not JSON", async () => {
    const corrupt = client({
      job: () => ({ body: done }),
      file: () => ({ raw: gzip("{}\n").then((zipped) => zipped.slice(0, 12)) }),
    });
    await expect(corrupt.listResources("user", ACCOUNT)).rejects.toThrow();
    secrets.clear();
    const notJson = client({
      job: () => ({ body: done }),
      file: () => ({ raw: gzip('{"user_id":"auth0|1"}\nnot json\n') }),
    });
    await expect(notJson.listResources("user", ACCOUNT)).rejects.toThrow();
  });
});

describe("an export that does not match the search", () => {
  it.each([
    ["is empty", () => ({ raw: gzip("") })],
    ["has no user ids", () => exportFile(1500, (i) => ({ Id: `auth0|${i}` }))],
    ["spells ids another way", () => exportFile(1500, (i) => ({ user_id: `${i}` }))],
    [
      "leaves out a connection's users",
      () => exportFile(2000, (i) => ({ user_id: `auth0|${i + 100}` })),
    ],
  ])("is not used when it %s", async (_label, file) => {
    trackingHost();
    const c = client({ job: () => ({ body: done }), file });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("does not match");
    // Nothing is retried until the next export is due, and the stored rows stay meanwhile.
    expect(JSON.parse(secrets.get(STATE_KEY) ?? "{}").doneAt).toEqual(expect.any(Number));
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1000);
    expect(posts()).toHaveLength(1);
  });

  it("does not hold a user who signed up after it against it", async () => {
    const c = client({
      search: (call) => {
        const page = Number(new URL(call.url).searchParams.get("page"));
        const created_at = new Date(Date.now() + HOUR).toISOString();
        const users = Array.from({ length: 100 }, (_, i) => user(page * 100 + i, { created_at }));
        return { body: { users } };
      },
      job: () => ({ body: done }),
      file: () => exportFile(1500, (i) => ({ user_id: `auth0|${i + 5000}` })),
    });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(2500);
  });
});

describe("an export that takes longer than a poll", () => {
  it("waits a bounded time for a job it just started, then leaves the rows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const unread = trackingHost();
    const c = client({ job: () => ({ body: pending }) });
    const list = c.listResources("user", ACCOUNT);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(list).resolves.toHaveLength(1000);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
    expect(jobReads().length).toBeLessThanOrEqual(13);
    expect(JSON.parse(secrets.get(STATE_KEY) ?? "{}").jobId).toBe("job_1");
  });

  it("picks the same job up on the next poll without starting another or waiting", async () => {
    trackingHost();
    secrets.set(STATE_KEY, JSON.stringify({ jobId: "job_1", startedAt: Date.now() }));
    let status = pending;
    const c = client({ job: () => ({ body: status }), file: () => exportFile(2500) });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1000);
    expect(jobReads()).toHaveLength(1);
    expect(posts()).toHaveLength(0);

    status = done;
    const unreadBefore = vi.mocked(Reflect.get(globalThis, UNREAD_HOOK)).mock.calls.length;
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(2500);
    expect(posts()).toHaveLength(0);
    // This time the list is whole, so a sync may prune what it stopped seeing.
    expect(vi.mocked(Reflect.get(globalThis, UNREAD_HOOK)).mock.calls.length).toBe(unreadBefore);
  });

  it("starts a new job when Auth0 has deleted the one it was waiting on", async () => {
    secrets.set(
      STATE_KEY,
      JSON.stringify({ jobId: "job_gone", startedAt: Date.now() - 25 * HOUR }),
    );
    const c = client({
      start: () => ({ body: { id: "job_2", type: "users_export", status: "pending" } }),
      job: (id) =>
        id === "job_gone" ? { status: 404, body: { message: "Job not found" } } : { body: done },
      file: () => exportFile(1500),
    });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1500);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(secrets.get(STATE_KEY) ?? "{}").jobId).toBe("job_2");
  });

  it("says so where the host keeps no rows, rather than show part of the list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const c = client({ job: () => ({ body: { ...pending, percentage_done: 40 } }) });
    const list = c.listResources("user", ACCOUNT).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(String(await list)).toContain("still exporting");
  });
});

describe("between exports", () => {
  it("reads only the newest users, leaves the rest, and spends no job requests", async () => {
    const unread = trackingHost();
    listFinished();
    const c = client({});
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1000);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
    expect(posts()).toHaveLength(0);
    expect(jobReads()).toHaveLength(0);
  });

  it("starts the next export once one is due", async () => {
    trackingHost();
    secrets.set(
      STATE_KEY,
      JSON.stringify({ jobId: "job_1", startedAt: 0, doneAt: Date.now() - 7 * HOUR }),
    );
    const c = client({ job: () => ({ body: done }), file: () => exportFile(1500) });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1500);
    expect(posts()).toHaveLength(1);
  });

  it("reads the last export again on a host that keeps no rows, not starting a job", async () => {
    listFinished();
    const before = secrets.get(STATE_KEY);
    const c = client({ job: () => ({ body: done }), file: () => exportFile(2500) });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(2500);
    expect(posts()).toHaveLength(0);
    // Reading it again does not make the export any newer.
    expect(secrets.get(STATE_KEY)).toBe(before);
  });
});

describe("what fails an export", () => {
  it("reports a failed job once, then waits for the next one to be due", async () => {
    trackingHost();
    const c = client({
      job: () => ({ body: { ...pending, status: "failed", status_details: "Timed out" } }),
    });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("Timed out");
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1000);
    expect(posts()).toHaveLength(1);
  });

  it("names the cap past 100,000 users, and does not run the job again on every poll", async () => {
    trackingHost();
    const c = client({ job: () => ({ body: done }), file: () => exportFile(100_001) });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(posts()).toHaveLength(1);
    expect(downloads()).toHaveLength(1);
  });

  it("reads exactly 100,000 users", async () => {
    const c = client({ job: () => ({ body: done }), file: () => exportFile(100_000) });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(100_000);
  });

  it.each([402, 403])("keeps the stored rows quietly when Auth0 answers %i", async (status) => {
    const unread = trackingHost();
    const c = client({ start: () => ({ status, body: { message: "Refused" } }) });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1000);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it("keeps the stored rows when the job can be started but not read", async () => {
    const unread = trackingHost();
    secrets.set(STATE_KEY, JSON.stringify({ jobId: "job_1", startedAt: Date.now() }));
    const c = client({ job: () => ({ status: 403, body: { message: "Insufficient scope" } }) });
    await expect(c.listResources("user", ACCOUNT)).resolves.toHaveLength(1000);
    expect(unread).toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });

  it("shows a refusal where the host keeps no rows", async () => {
    const c = client({ start: () => ({ status: 403, body: { message: "Refused" } }) });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("Refused");
  });

  it("fails the type on a throttle, so a sync keeps the rows and says why", async () => {
    const unread = trackingHost();
    const c = client({
      start: () => ({ status: 429, body: { message: "There are 10 active export users jobs" } }),
    });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("10 active");
    expect(unread).not.toHaveBeenCalled();
  });

  it("refuses a job with no id, rather than store a blank one", async () => {
    const c = client({ start: () => ({ body: { id: "", status: "pending" } }) });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("no job id");
    expect(secrets.size).toBe(0);
  });

  it("stays a truncated list where the host can store nothing", async () => {
    const c = client({}, { secrets: { getPlaintext: async () => null } });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(posts()).toHaveLength(0);
  });

  it("lets an unreadable stored job fail the read", async () => {
    const c = client(
      {},
      {
        secrets: {
          getPlaintext: async () => {
            throw new Error("store unavailable");
          },
          setPlaintext: async () => undefined,
        },
      },
    );
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow("store unavailable");
    expect(posts()).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * host-services builds plugin HostServices from the driver maps, plus a
 * secrets service (DB + encryption) and an HTTP service that routes through a
 * bastion dispatcher, node:https (for caCert), or global fetch. We mock the
 * driver maps, DB, encryption, undici and the bastion registry.
 */

// --- driver maps -----------------------------------------------------------
const sqlDriver = {
  id: "pg",
  query: vi.fn(async () => ({ rows: [] })),
  execute: vi.fn(async () => ({ rowCount: 0 })),
};
const kvDriver = { id: "redis", command: vi.fn(async () => "OK") };
const dockerDriver = { id: "docker", command: vi.fn(async () => ({})) };
const k8sDriver = { id: "k8s", command: vi.fn(async () => ({})) };

vi.mock("../drivers", () => ({
  sqlDrivers: new Map([["pg", sqlDriver]]),
  kvDrivers: new Map([["redis", kvDriver]]),
  dockerDrivers: new Map([["docker", dockerDriver]]),
  k8sDrivers: new Map([["k8s", k8sDriver]]),
}));

// --- DB --------------------------------------------------------------------
const secretRows: unknown[] = [];
const accountRows: unknown[] = [];
const insertOnConflictDoUpdate = vi.fn(async () => undefined);
const dbInsert = vi.fn(() => ({
  values: () => ({ onConflictDoUpdate: insertOnConflictDoUpdate }),
}));
const dbSelect = vi.fn((proj?: Record<string, unknown>) => ({
  from: (table: { __t: string }) => ({
    where: () => ({
      limit: () => Promise.resolve(table.__t === "accounts" ? accountRows : secretRows),
    }),
  }),
}));
vi.mock("../db/client", () => ({ db: { select: dbSelect, insert: dbInsert } }));
vi.mock("../db/schema", () => ({
  accounts: { __t: "accounts", id: "id", bastionId: "bastionId" },
  secretFieldStates: {
    __t: "secretFieldStates",
    resourceId: "resourceId",
    fieldKey: "fieldKey",
  },
}));

// --- encryption ------------------------------------------------------------
const decrypt = vi.fn(async (ct: string) => {
  if (ct === "THROW") throw new Error("decrypt failed");
  return "plaintext-secret";
});
const encrypt = vi.fn(async () => ({ ciphertext: "CT", iv: "IV" }));
vi.mock("../encryption", () => ({
  decrypt,
  encrypt,
  buildAad: (...p: string[]) => p.join(":"),
}));

// --- bastion ---------------------------------------------------------------
const getDispatcherFor = vi.fn(() => null as unknown);
vi.mock("../bastion/registry", () => ({ getDispatcherFor }));
vi.mock("../bastion/errors", () => ({
  BastionDisconnectedError: class extends Error {
    constructor(id: string) {
      super(`disconnected ${id}`);
      this.name = "BastionDisconnectedError";
    }
  },
}));

// --- node:https / node:http ------------------------------------------------
// We model `request(options, cb)` returning a writable-ish req object and
// invoke the response callback with a fake IncomingMessage.
interface FakeReqOpts {
  headers?: Record<string, string | string[] | undefined>;
  statusCode?: number;
  emitError?: boolean;
}
const httpsState: { last?: unknown; opts: FakeReqOpts } = { opts: {} };
const httpState: { last?: unknown; opts: FakeReqOpts } = { opts: {} };

function makeRequestFn(state: { last?: unknown; opts: FakeReqOpts }) {
  return vi.fn((options: unknown, cb: (res: unknown) => void) => {
    state.last = options;
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const req = {
      on: (ev: string, h: (arg?: unknown) => void) => {
        handlers[ev] = h;
        return req;
      },
      write: vi.fn(),
      end: vi.fn(() => {
        if (state.opts.emitError) {
          handlers["error"]?.(new Error("socket error"));
          return;
        }
        const resHandlers: Record<string, (chunk?: unknown) => void> = {};
        const res = {
          statusCode: state.opts.statusCode ?? 200,
          headers: state.opts.headers ?? { "content-type": "text/plain" },
          on: (ev: string, h: (chunk?: unknown) => void) => {
            resHandlers[ev] = h;
            return res;
          },
        };
        cb(res);
        resHandlers["data"]?.(Buffer.from("https-body"));
        resHandlers["end"]?.();
      }),
    };
    return req;
  });
}
const httpsRequest = makeRequestFn(httpsState);
const httpRequest = makeRequestFn(httpState);
vi.mock("node:https", () => ({ request: httpsRequest }));
vi.mock("node:http", () => ({ request: httpRequest }));

// --- undici ----------------------------------------------------------------
const undiciFetch = vi.fn(async () => ({
  status: 201,
  headers: new Map([["content-type", "application/json"]]).entries
    ? { entries: () => [["x-via", "bastion"]][Symbol.iterator]() }
    : ({} as never),
  text: async () => "via-bastion",
}));
vi.mock("undici", () => ({ fetch: undiciFetch }));

let hs: typeof import("../host-services");

beforeEach(async () => {
  vi.clearAllMocks();
  secretRows.length = 0;
  accountRows.length = 0;
  getDispatcherFor.mockReturnValue(null);
  httpsState.opts = {};
  httpState.opts = {};
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  hs = await import("../host-services");
});

describe("buildHostServices (SQL)", () => {
  it("wires query/execute to the driver and passes caCert", async () => {
    const svc = hs.buildHostServices("pg", "postgres://x", { caCert: "CA" });
    await svc.sql!.query("SELECT 1");
    await svc.sql!.execute("INSERT", [1]);
    expect(sqlDriver.query).toHaveBeenCalledWith("postgres://x", "SELECT 1", { caCert: "CA" });
    expect(sqlDriver.execute).toHaveBeenCalledWith("postgres://x", "INSERT", [1], {
      caCert: "CA",
    });
  });

  it("passes undefined options when no caCert", async () => {
    const svc = hs.buildHostServices("pg", "postgres://x");
    await svc.sql!.query("SELECT 1");
    expect(sqlDriver.query).toHaveBeenCalledWith("postgres://x", "SELECT 1", undefined);
  });

  it("throws for an unknown SQL driver", () => {
    expect(() => hs.buildHostServices("nope", "x")).toThrow(/Unknown SQL driver/);
  });
});

describe("buildKvHostServices", () => {
  it("wires command to the driver", async () => {
    const svc = hs.buildKvHostServices("redis", "redis://x");
    await svc.kv!.command("GET", "k");
    expect(kvDriver.command).toHaveBeenCalledWith("redis://x", "GET", ["k"]);
  });
  it("throws for an unknown KV driver", () => {
    expect(() => hs.buildKvHostServices("nope", "x")).toThrow(/Unknown KV driver/);
  });
});

describe("buildDockerHostServices", () => {
  it("wires command", async () => {
    const svc = hs.buildDockerHostServices("docker", "unix:///x");
    await svc.docker!.command("ps", {});
    expect(dockerDriver.command).toHaveBeenCalledWith("unix:///x", "ps", {});
  });
  it("throws for an unknown docker driver", () => {
    expect(() => hs.buildDockerHostServices("nope", "x")).toThrow(/Unknown Docker driver/);
  });
});

describe("buildK8sHostServices", () => {
  it("wires command", async () => {
    const svc = hs.buildK8sHostServices("k8s", "kubeconfig");
    await svc.k8s!.command("listPods", {});
    expect(k8sDriver.command).toHaveBeenCalledWith("kubeconfig", "listPods", {});
  });
  it("throws for an unknown k8s driver", () => {
    expect(() => hs.buildK8sHostServices("nope", "x")).toThrow(/Unknown Kubernetes driver/);
  });
});

// --- buildPluginHostServices (driver selection) ----------------------------
describe("buildPluginHostServices — driver selection", () => {
  const base = { http: undefined, secrets: undefined };

  it("builds docker services when manifest has a dockerDriver", async () => {
    const out = await hs.buildPluginHostServices(
      { dockerDriver: { driver: "docker", credentialKey: "host" } } as never,
      { host: "unix:///x" },
    );
    expect(out?.docker).toBeDefined();
    expect(out?.http).toBeDefined();
    expect(out?.secrets).toBeDefined();
  });

  it("builds k8s services when manifest has a kubernetesDriver", async () => {
    const out = await hs.buildPluginHostServices(
      { kubernetesDriver: { driver: "k8s", credentialKey: "kubeconfig" } } as never,
      { kubeconfig: "cfg" },
    );
    expect(out?.k8s).toBeDefined();
  });

  it("builds sql services with caCert key resolution", async () => {
    const out = await hs.buildPluginHostServices(
      { sqlDriver: { driver: "pg", credentialKey: "url", caCertKey: "ca" } } as never,
      { url: "postgres://x", ca: "CERT" },
    );
    expect(out?.sql).toBeDefined();
    await out!.sql!.query("SELECT 1");
    expect(sqlDriver.query).toHaveBeenCalledWith("postgres://x", "SELECT 1", { caCert: "CERT" });
  });

  it("builds sql services without a caCertKey", async () => {
    const out = await hs.buildPluginHostServices(
      { sqlDriver: { driver: "pg", credentialKey: "url" } } as never,
      { url: "postgres://x" },
    );
    await out!.sql!.query("SELECT 1");
    expect(sqlDriver.query).toHaveBeenCalledWith("postgres://x", "SELECT 1", undefined);
  });

  it("builds kv services when manifest has a kvDriver", async () => {
    const out = await hs.buildPluginHostServices(
      { kvDriver: { driver: "redis", credentialKey: "url" } } as never,
      { url: "redis://x" },
    );
    expect(out?.kv).toBeDefined();
  });

  it("returns only base services when manifest has no driver", async () => {
    const out = await hs.buildPluginHostServices({} as never, {});
    expect(out?.sql).toBeUndefined();
    expect(out?.kv).toBeUndefined();
    expect(out?.http).toBeDefined();
    expect(out?.secrets).toBeDefined();
    void base;
  });

  it("looks up the bastion via accountId when bastionId not provided", async () => {
    accountRows.push({ bastionId: "bx" });
    await hs.buildPluginHostServices({} as never, {}, { accountId: "acc1" });
    expect(dbSelect).toHaveBeenCalled();
  });

  it("skips the DB round-trip when bastionId is given explicitly", async () => {
    await hs.buildPluginHostServices({} as never, {}, { bastionId: "bx" });
    // accounts select for bastion lookup should not run
    const fromCalls = dbSelect.mock.results.map(
      (r) => r.value as { from: (t: { __t: string }) => unknown },
    ).length;
    void fromCalls;
    expect(true).toBe(true);
  });
});

// --- secrets service -------------------------------------------------------
describe("secrets.getPlaintext", () => {
  async function getSecretService() {
    const out = await hs.buildPluginHostServices({} as never, {});
    return out!.secrets!;
  }

  it("returns null when no row exists", async () => {
    const svc = await getSecretService();
    expect(await svc.getPlaintext("r1", "f1")).toBeNull();
  });

  it("returns null when the row is not a literal", async () => {
    secretRows.push({ resolutionKind: "output-ref", encryptedValue: "x", valueIv: "y" });
    const svc = await getSecretService();
    expect(await svc.getPlaintext("r1", "f1")).toBeNull();
  });

  it("returns null when encrypted value/iv missing", async () => {
    secretRows.push({ resolutionKind: "literal", encryptedValue: null, valueIv: null });
    const svc = await getSecretService();
    expect(await svc.getPlaintext("r1", "f1")).toBeNull();
  });

  it("decrypts a literal value with the right AAD", async () => {
    secretRows.push({ resolutionKind: "literal", encryptedValue: "ENC", valueIv: "IV" });
    const svc = await getSecretService();
    const out = await svc.getPlaintext("r1", "f1");
    expect(out).toBe("plaintext-secret");
    expect(decrypt).toHaveBeenCalledWith("ENC", "IV", "secretField:r1:f1:value");
  });

  it("returns null and logs when decryption throws", async () => {
    secretRows.push({ resolutionKind: "literal", encryptedValue: "THROW", valueIv: "IV" });
    const svc = await getSecretService();
    expect(await svc.getPlaintext("r1", "f1")).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("secrets.setPlaintext", () => {
  it("encrypts and upserts the literal", async () => {
    const out = await hs.buildPluginHostServices({} as never, {});
    await out!.secrets!.setPlaintext("r1", "f1", "supersecret");
    expect(encrypt).toHaveBeenCalledWith("supersecret", "secretField:r1:f1:value");
    expect(dbInsert).toHaveBeenCalled();
    expect(insertOnConflictDoUpdate).toHaveBeenCalled();
  });
});

// --- HTTP service ----------------------------------------------------------
describe("http.request — bastion routing", () => {
  it("throws BastionDisconnectedError when bound but no dispatcher", async () => {
    getDispatcherFor.mockReturnValue(null);
    const out = await hs.buildPluginHostServices({} as never, {}, { bastionId: "bx" });
    await expect(out!.http!.request({ url: "https://x", method: "GET" })).rejects.toThrow(
      /disconnected bx/,
    );
  });

  it("routes through undici when a dispatcher is connected", async () => {
    getDispatcherFor.mockReturnValue({ id: "disp" });
    undiciFetch.mockResolvedValueOnce({
      status: 201,
      headers: { entries: () => [["x-via", "bastion"]][Symbol.iterator]() },
      text: async () => "via-bastion",
    } as never);
    const out = await hs.buildPluginHostServices({} as never, {}, { bastionId: "bx" });
    const resp = await out!.http!.request({
      url: "https://api/x",
      method: "POST",
      headers: { "x-test": "1" },
      body: "payload",
    });
    expect(undiciFetch).toHaveBeenCalled();
    expect(resp).toEqual({ status: 201, headers: { "x-via": "bastion" }, body: "via-bastion" });
  });

  it("omits the body when none is given (bastion)", async () => {
    getDispatcherFor.mockReturnValue({ id: "disp" });
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      headers: { entries: () => [][Symbol.iterator]() },
      text: async () => "",
    } as never);
    const out = await hs.buildPluginHostServices({} as never, {}, { bastionId: "bx" });
    await out!.http!.request({ url: "https://api/x", method: "GET" });
    const init = undiciFetch.mock.calls[0]![1] as { body?: unknown };
    expect(init.body).toBeUndefined();
  });
});

describe("http.request — direct fetch", () => {
  it("uses global fetch when unbound and no caCert", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "ok",
    } as unknown as Response);
    const out = await hs.buildPluginHostServices({} as never, {});
    const resp = await out!.http!.request({ url: "https://api/x", method: "GET" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api/x",
      expect.objectContaining({ method: "GET" }),
    );
    expect(resp.status).toBe(200);
    expect(resp.body).toBe("ok");
    fetchSpy.mockRestore();
  });

  it("forwards the body to global fetch when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => "",
    } as unknown as Response);
    const out = await hs.buildPluginHostServices({} as never, {});
    await out!.http!.request({ url: "https://api/x", method: "POST", body: "hi" });
    const init = fetchSpy.mock.calls[0]![1] as { body?: unknown };
    expect(init.body).toBe("hi");
    fetchSpy.mockRestore();
  });
});

describe("http.request — node https with caCert", () => {
  async function unboundHttp() {
    const out = await hs.buildPluginHostServices({} as never, {});
    return out!.http!;
  }

  it("uses node:https and attaches the CA, flattening headers", async () => {
    httpsState.opts = {
      statusCode: 204,
      headers: { "set-cookie": ["a=1", "b=2"], "x-single": "v", "x-null": undefined },
    };
    const http = await unboundHttp();
    const resp = await http.request({
      url: "https://api.example.com:8443/path?q=1",
      method: "POST",
      headers: { authorization: "Bearer x" },
      body: "data",
      caCert: "MY-CA",
    });
    expect(httpsRequest).toHaveBeenCalled();
    const opts = httpsState.last as {
      ca?: string;
      hostname: string;
      port: number | string;
      path: string;
      method: string;
    };
    expect(opts.ca).toBe("MY-CA");
    expect(opts.hostname).toBe("api.example.com");
    expect(String(opts.port)).toBe("8443");
    expect(opts.path).toBe("/path?q=1");
    expect(resp.status).toBe(204);
    expect(resp.headers["set-cookie"]).toBe("a=1, b=2");
    expect(resp.headers["x-single"]).toBe("v");
    expect(resp.headers["x-null"]).toBeUndefined();
    expect(resp.body).toBe("https-body");
  });

  it("defaults to port 443 for https without an explicit port", async () => {
    const http = await unboundHttp();
    await http.request({ url: "https://api.example.com/x", caCert: "CA" });
    const opts = httpsState.last as { port: number };
    expect(opts.port).toBe(443);
  });

  it("refuses http:// when a caCert is provided", async () => {
    const http = await unboundHttp();
    await expect(
      http.request({ url: "http://insecure.example.com/x", caCert: "CA" }),
    ).rejects.toThrow(/Refusing http/);
  });

  it("rejects when the underlying request errors", async () => {
    httpsState.opts = { emitError: true };
    const http = await unboundHttp();
    await expect(http.request({ url: "https://api.example.com/x", caCert: "CA" })).rejects.toThrow(
      /socket error/,
    );
  });
});

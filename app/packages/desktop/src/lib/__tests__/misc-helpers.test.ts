import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-ws getCloudWsUrl", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("derives ws:// from http:// and caches the http url", async () => {
    invoke.mockResolvedValue("http://localhost:3000");
    const { getCloudWsUrl } = await import("../cloud-ws");
    const url = await getCloudWsUrl();
    expect(url).toBe("ws://localhost:3000");
    expect(invoke).toHaveBeenCalledWith("cloud_get_url");
    // second call uses cache — invoke not called again
    const url2 = await getCloudWsUrl();
    expect(url2).toBe("ws://localhost:3000");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("derives wss:// from https://", async () => {
    vi.resetModules();
    invoke.mockResolvedValue("https://cloud.infrawrench.com");
    const { getCloudWsUrl } = await import("../cloud-ws");
    const url = await getCloudWsUrl();
    expect(url).toBe("wss://cloud.infrawrench.com");
  });
});

describe("sql-session", () => {
  it("stores and merges session data per account", async () => {
    const { getSqlSession, setSqlSession } = await import("../sql-session");
    expect(getSqlSession("acc-x")).toBeUndefined();

    setSqlSession("acc-x", { connectionString: "postgres://x" });
    expect(getSqlSession("acc-x")).toEqual({ connectionString: "postgres://x" });

    setSqlSession("acc-x", { connectionString: "postgres://x", tablesJson: "[]" });
    expect(getSqlSession("acc-x")).toEqual({
      connectionString: "postgres://x",
      tablesJson: "[]",
    });
  });
});

describe("metric-pings event helper", () => {
  it("dispatches a custom event on window", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const { METRIC_PINGS_CHANGED_EVENT, notifyMetricPingsChanged } =
      await import("../metric-pings");
    notifyMetricPingsChanged();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const evt = dispatchEvent.mock.calls[0]![0] as CustomEvent;
    expect(evt.type).toBe(METRIC_PINGS_CHANGED_EVENT);
    vi.unstubAllGlobals();
  });
});

describe("ssh-agent sentinels", () => {
  it("exposes pageant and 1password sentinels", async () => {
    const { PAGEANT_SENTINEL, ONEPASSWORD_SENTINEL } = await import("../ssh-agent");
    expect(PAGEANT_SENTINEL).toBe("__pageant__");
    expect(ONEPASSWORD_SENTINEL).toBe("__1password__");
  });
});

describe("db/client", () => {
  it("select routes to db_select with defaulted params", async () => {
    const { getDb } = await import("../../db/client");
    invoke.mockResolvedValue([{ id: 1 }]);
    const db = await getDb();
    await db.select("SELECT 1");
    expect(invoke).toHaveBeenCalledWith("db_select", { sql: "SELECT 1", params: [] });
  });

  it("execute routes to db_execute with given params", async () => {
    const { getDb } = await import("../../db/client");
    invoke.mockResolvedValue({ rowsAffected: 1, lastInsertId: 5 });
    const db = await getDb();
    const res = await db.execute("INSERT INTO t VALUES ($1)", ["x"]);
    expect(invoke).toHaveBeenCalledWith("db_execute", {
      sql: "INSERT INTO t VALUES ($1)",
      params: ["x"],
    });
    expect(res).toEqual({ rowsAffected: 1, lastInsertId: 5 });
  });
});

describe("ssh-tunnel helpers", () => {
  it("sshOpenTunnel forwards payload flatly", async () => {
    invoke.mockResolvedValue({ tunnelId: "t1", localPort: 5000 });
    const { sshOpenTunnel } = await import("../ssh-tunnel");
    const payload = {
      sshHost: "h",
      sshPort: 22,
      sshUser: "u",
      privateKey: "k",
      remoteHost: "rh",
      remotePort: 5432,
    };
    const res = await sshOpenTunnel(payload);
    expect(invoke).toHaveBeenCalledWith("ssh_open_tunnel", { ...payload });
    expect(res).toEqual({ tunnelId: "t1", localPort: 5000 });
  });

  it("sshExecCommand wraps config and command", async () => {
    invoke.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
    const { sshExecCommand } = await import("../ssh-tunnel");
    const config = { sshHost: "h", sshPort: 22, sshUser: "u", privateKey: "k" };
    await sshExecCommand(config, "ls -la");
    expect(invoke).toHaveBeenCalledWith("ssh_exec_command", {
      config: { ...config },
      command: "ls -la",
    });
  });
});

describe("node-fetch-shim", () => {
  it("re-exports the platform fetch and web classes", async () => {
    vi.stubGlobal(
      "fetch",
      Object.assign(
        vi.fn(() => Promise.resolve(new Response("x"))),
        {},
      ),
    );
    const mod = await import("../node-fetch-shim");
    expect(typeof mod.default).toBe("function");
    expect(mod.Headers).toBe(globalThis.Headers);
    expect(mod.Request).toBe(globalThis.Request);
    expect(mod.Response).toBe(globalThis.Response);
    expect(mod.FormData).toBe(globalThis.FormData);
    expect(mod.Blob).toBe(globalThis.Blob);
    vi.unstubAllGlobals();
  });
});

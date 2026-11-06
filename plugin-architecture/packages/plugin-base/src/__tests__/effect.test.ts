import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { CostSetupError } from "../cost.js";
import {
  attempt,
  attemptStream,
  buildAssociationCatalog,
  collectNodeDrivers,
  hostClient,
  hostPlugin,
  hostPlugins,
  PluginError,
  runPluginEffect,
} from "../effect.js";
import type { Plugin, PluginClient } from "../manifest.js";
import type { PluginEffect } from "../contract-effect.js";
import { o, rt } from "../resource-builders.js";

class Boom extends Error {}

class TestClient {
  calls = 0;
  #secret = "private state";

  list(): PluginEffect<string[]> {
    return attempt(async () => {
      this.calls += 1;
      return [this.#secret];
    });
  }
  remove(): PluginEffect<void> {
    return attempt(async () => {
      this.calls += 1;
    });
  }
  fail(error: unknown): PluginEffect<never> {
    return attempt(async () => {
      throw error;
    });
  }
  render(id: string) {
    return { id };
  }
  stream() {
    return attemptStream(async function* () {
      yield 1;
      yield 2;
    });
  }
  brokenStream() {
    return attemptStream(async function* () {
      yield 1;
      throw new Boom("mid stream");
    });
  }
}

describe("hostClient", () => {
  it("runs a contract method on call, not on await", () => {
    const raw = new TestClient();
    const client = hostClient(raw);
    void client.remove();
    expect(raw.calls).toBe(1);
  });

  it("keeps a raw contract method lazy", async () => {
    const raw = new TestClient();
    const effect = raw.remove();
    expect(raw.calls).toBe(0);
    await Effect.runPromise(effect);
    expect(raw.calls).toBe(1);
  });

  it("runs against the original instance, so #private state works", async () => {
    await expect(hostClient(new TestClient()).list()).resolves.toEqual(["private state"]);
  });

  it("rethrows exactly what the plugin threw", async () => {
    const boom = new Boom("no");
    await expect(hostClient(new TestClient()).fail(boom)).rejects.toBe(boom);
  });

  it("keeps typed failures typed, in the channel and across the boundary", async () => {
    const setup = new CostSetupError("enable the export");
    const exit = await Effect.runPromise(Effect.flip(new TestClient().fail(setup)));
    expect(exit._tag).toBe("CostSetupError");
    await expect(hostClient(new TestClient()).fail(setup)).rejects.toBeInstanceOf(CostSetupError);
  });

  it("wraps an untyped throw in PluginError inside the channel", async () => {
    const failure = await Effect.runPromise(Effect.flip(new TestClient().fail("plain string")));
    expect(failure).toBeInstanceOf(PluginError);
    expect(failure.message).toBe("plain string");
  });

  it("surfaces a PluginError with no cause as itself", async () => {
    const native = new PluginError({ message: "native" });
    const client = hostClient({ op: () => Effect.fail(native) });
    await expect(client.op()).rejects.toBe(native);
  });

  it("passes synchronous methods and non-functions through", () => {
    const client = hostClient(new TestClient());
    expect(client.render("a")).toEqual({ id: "a" });
    expect(client.calls).toBe(0);
  });

  it("reads an absent optional method as undefined", () => {
    const client = hostClient<{ maybe?: () => PluginEffect<void> }>({});
    expect(client.maybe).toBeUndefined();
  });

  it("gives the same wrapper on each read", () => {
    const client = hostClient(new TestClient());
    expect(client.list).toBe(client.list);
  });

  it("turns a contract stream into an async iterable", async () => {
    const out: number[] = [];
    for await (const value of hostClient(new TestClient()).stream()) out.push(value);
    expect(out).toEqual([1, 2]);
  });

  it("rethrows what a stream threw, after what it yielded", async () => {
    const out: number[] = [];
    const run = async () => {
      for await (const value of hostClient(new TestClient()).brokenStream()) out.push(value);
    };
    await expect(run()).rejects.toBeInstanceOf(Boom);
    expect(out).toEqual([1]);
  });
});

describe("runPluginEffect", () => {
  it("accepts the Promise a test double returns", async () => {
    await expect(runPluginEffect(Promise.resolve(1))).resolves.toBe(1);
    await expect(runPluginEffect(Effect.succeed(1))).resolves.toBe(1);
  });
});

const fakePlugin = (id: string, resourceTypes: Plugin["resourceTypes"] = []): Plugin => ({
  manifest: {
    id,
    displayName: id,
    logoSvg: "<svg/>",
    egressHosts: [],
    credentialFields: [],
  },
  resourceTypes,
  testCredentials: {},
  createClient: () =>
    ({
      getCreateConfig: () =>
        attempt(async () => ({
          fields: [
            { key: "value", label: "Value", kind: "resource-picker", associationRole: "dns-ipv4" },
          ],
        })),
    }) as unknown as PluginClient,
});

describe("association roles", () => {
  const server = rt({
    id: "server",
    name: "Server",
    description: "x",
    outputs: [o("ip", "IP", { dnsValue: "ipv4" }), o("internal", "Internal")],
  });

  it("collects flagged outputs across plugins, ignoring the rest", () => {
    const catalog = buildAssociationCatalog([fakePlugin("a", [server]), fakePlugin("b")]);
    expect(catalog.get("dns-ipv4")).toEqual([
      { pluginId: "a", resourceTypeId: "server", outputKey: "ip" },
    ]);
    expect(catalog.get("dns-ipv6")).toBeUndefined();
  });

  it("fills a create form's picker from every loaded plugin", async () => {
    const [plugin] = hostPlugins([fakePlugin("dns"), fakePlugin("compute", [server])]);
    const config = await plugin!.createClient({}).getCreateConfig!("record");
    expect(config.fields[0]?.associationSources).toEqual([
      { pluginId: "compute", resourceTypeId: "server", outputKey: "ip" },
    ]);
  });
});

describe("hostPlugin", () => {
  it("runs hooks on the plugin itself on call", async () => {
    const plugin = hostPlugin({
      ...fakePlugin("a"),
      listCredentialOptions: () => attempt(async () => [{ id: "x", label: "X" }]),
    });
    await expect(plugin.listCredentialOptions!("k", {})).resolves.toEqual([
      { id: "x", label: "X" },
    ]);
  });
});

describe("collectNodeDrivers", () => {
  const safe = {
    id: "pg",
    query: () => attempt(async () => [{ from: "server" }]),
    execute: () => attempt(async () => 0),
  };
  const full = {
    id: "pg",
    query: () => attempt(async () => [{ from: "desktop" }]),
    execute: () => attempt(async () => 0),
  };

  it("gives each kind of host the driver the plugin chose for it", async () => {
    const plugins = [{ desktop: { sql: full }, server: { sql: safe } }];
    const server = collectNodeDrivers(plugins, "server").sqlDrivers.get("pg");
    const desktop = collectNodeDrivers(plugins, "desktop").sqlDrivers.get("pg");
    await expect(server!.query("cs", "select 1")).resolves.toEqual([{ from: "server" }]);
    await expect(desktop!.query("cs", "select 1")).resolves.toEqual([{ from: "desktop" }]);
  });
});

describe("streams through Stream", () => {
  it("exposes a real Stream on the contract side", async () => {
    const collected = await Effect.runPromise(Stream.runCollect(new TestClient().stream()));
    expect(Array.from(collected)).toEqual([1, 2]);
  });
});

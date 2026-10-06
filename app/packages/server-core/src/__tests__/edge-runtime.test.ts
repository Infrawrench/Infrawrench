import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayOnlyError,
  isGatewayOnlyError,
  markEdgeRuntime,
  runGatewayChecked,
} from "../runtime/gateway-only";
import { gatewayOnlyHitInScope, keepAlive, runInRequestScope } from "../runtime/request-scope";

const require = createRequire(import.meta.url);
const EDGE_FLAG = Symbol.for("infrawrench.edgeRuntime");
const HIT_HOOK = Symbol.for("infrawrench.gatewayOnlyHit");

function clearEdge(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[EDGE_FLAG];
  delete g[HIT_HOOK];
}

afterEach(clearEdge);

describe("isGatewayOnlyError", () => {
  it("recognises the class, the stub's code, the marker, and wrapped causes", () => {
    expect(isGatewayOnlyError(new GatewayOnlyError("ssh2"))).toBe(true);
    expect(isGatewayOnlyError(Object.assign(new Error("x"), { code: "IW_GATEWAY_ONLY" }))).toBe(
      true,
    );
    expect(isGatewayOnlyError(new Error("query failed: [gateway-only] pg needs…"))).toBe(true);
    expect(
      isGatewayOnlyError(new Error("outer", { cause: new GatewayOnlyError("The pg driver") })),
    ).toBe(true);
    expect(isGatewayOnlyError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isGatewayOnlyError(undefined)).toBe(false);
  });
});

describe("the gateway-only stub", () => {
  const stub = require("../../edge/gateway-only-stub.cjs");

  it("loads freely and throws the gateway-only error when used", () => {
    expect(() => stub.Client).not.toThrow();
    expect(() => new stub.Client()).toThrow(/\[gateway-only\]/);
    expect(() => stub.utils.parseKey("k")).toThrow(/node-only module\.utils\.parseKey/);
    let caught: unknown;
    try {
      stub();
    } catch (e) {
      caught = e;
    }
    expect(isGatewayOnlyError(caught)).toBe(true);
  });

  it("is not a thenable, so awaiting it does not hang", async () => {
    expect(stub.then).toBeUndefined();
    await expect(Promise.resolve(stub)).resolves.toBe(stub);
  });

  it("can be subclassed, failing only on construction", () => {
    class Derived extends stub.Duplex {}
    expect(() => new Derived()).toThrow(/\[gateway-only\]/);
  });
});

describe("runGatewayChecked", () => {
  it("is a plain call off the edge", async () => {
    await expect(runGatewayChecked(async () => 42)).resolves.toBe(42);
  });

  it("fails work that swallowed a gateway-only error, and marks the enclosing scope", async () => {
    markEdgeRuntime();
    const stub = require("../../edge/gateway-only-stub.cjs");
    const scope = { gatewayOnly: {} };
    await runInRequestScope(scope, async () => {
      const outcome = runGatewayChecked(async () => {
        try {
          stub.query("SELECT 1");
        } catch {
          return ["placeholder"]; // what the Postgres plugin does
        }
        return ["real"];
      });
      await expect(outcome).rejects.toSatisfy(isGatewayOnlyError);
      expect(gatewayOnlyHitInScope()).toBe("node-only module.query");
    });
  });

  it("passes through work that never touched a gateway-only path", async () => {
    markEdgeRuntime();
    await runInRequestScope({ gatewayOnly: {} }, async () => {
      await expect(runGatewayChecked(async () => "fine")).resolves.toBe("fine");
      expect(gatewayOnlyHitInScope()).toBeUndefined();
    });
  });
});

describe("keepAlive", () => {
  it("hands the promise to the scope's waitUntil and returns it unchanged", async () => {
    const kept: Promise<unknown>[] = [];
    await runInRequestScope({ waitUntil: (p) => kept.push(p) }, async () => {
      const p = Promise.resolve("done");
      expect(keepAlive(p)).toBe(p);
    });
    expect(kept).toHaveLength(1);
  });

  it("is a no-op outside a scope", () => {
    const p = Promise.resolve(1);
    expect(keepAlive(p)).toBe(p);
  });
});

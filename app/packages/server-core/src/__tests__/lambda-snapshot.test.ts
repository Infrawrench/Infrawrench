import nodeCrypto, { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  afterSnapshotRestore,
  assertSnapshotSafe,
  initRandomnessUses,
  prepareSnapshotRandomness,
  withInitRandomnessAllowed,
} from "../runtime/lambda-snapshot";

// One process-wide preparation, as in the runtime; the tests run in order.
prepareSnapshotRandomness();

describe("SnapStart randomness", () => {
  it("replaces Math.random with a CSPRNG-fed generator in [0, 1)", () => {
    const draws = Array.from({ length: 2000 }, () => Math.random());
    expect(draws.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(new Set(draws).size).toBe(draws.length);
  });

  it("records draws made during init with their call site", () => {
    nodeCrypto.randomBytes(8);
    // The named import follows the patched module object.
    randomUUID();
    globalThis.crypto.getRandomValues(new Uint8Array(4));
    const apis = initRandomnessUses().map((use) => use.api);
    expect(apis).toEqual(
      expect.arrayContaining([
        "Math.random",
        "crypto.randomBytes",
        "crypto.randomUUID",
        "crypto.getRandomValues",
      ]),
    );
  });

  it("does not record draws inside an allowed scope, across awaits", async () => {
    const before = initRandomnessUses().length;
    await withInitRandomnessAllowed("SDK request ids", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      randomUUID();
      globalThis.crypto.randomUUID();
    });
    expect(initRandomnessUses().length).toBe(before);
  });

  it("refuses the snapshot over crypto draws, naming them, then stops recording", () => {
    expect(() => assertSnapshotSafe()).toThrow(/crypto\.randomBytes at .*lambda-snapshot\.test/);
    const after = initRandomnessUses().length;
    randomUUID();
    expect(initRandomnessUses().length).toBe(after);
  });

  it("only reports Math.random draws", () => {
    // The state is process-wide; record again on a clean slate.
    const shared = (globalThis as Record<symbol, { recording: boolean; uses: unknown[] }>)[
      Symbol.for("infrawrench.lambda.snapshot")
    ]!;
    shared.uses.length = 0;
    shared.recording = true;
    Math.random();
    expect(assertSnapshotSafe()).toMatch(/^Init drew Math\.random[\s\S]*lambda-snapshot\.test/);
    shared.uses.length = 0;
    expect(assertSnapshotSafe()).toBeNull();
  });

  it("keeps UUIDs well formed and distinct with the entropy cache off", () => {
    afterSnapshotRestore();
    const ids = Array.from({ length: 300 }, () => globalThis.crypto.randomUUID());
    expect(
      ids.every((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
      ),
    ).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Randomness for a Lambda execution environment that is restored from a
 * SnapStart snapshot (`lambda-runtime.ts`).
 *
 * A snapshot is the whole process's memory, and every environment Lambda
 * resumes from it starts with the same bytes. The kernel's generator and the
 * snapshot-safe OpenSSL of the `provided.al2023` image (which AL2023's Node
 * links against, unlike the Node base image's bundled copy) are reseeded on
 * restore, so anything that reads from them afterwards is fine. Three things
 * are not:
 *
 * - **`Math.random`.** V8 seeds its generator once per isolate, so every
 *   restored environment would draw the same sequence. It is replaced with
 *   one fed by `crypto.randomFillSync`, whose buffer is discarded on restore.
 * - **`crypto.randomUUID`'s entropy cache.** Node fills a batch of 128 UUIDs'
 *   worth of random bytes on first use and hands them out one at a time; a
 *   batch started during init would give every restored environment the same
 *   next UUIDs. The cache is turned off.
 * - **Random values a library keeps.** A pool (`uuid`'s, `nanoid`'s) or an
 *   id minted at import time (bson's ObjectId process id was one, which is
 *   why the MongoDB plugin loads its driver lazily) is copied into every
 *   environment, and nothing here can reach inside it. So every draw during
 *   init is recorded with its call site, and {@link assertSnapshotSafe}
 *   refuses the snapshot when `node:crypto` or Web Crypto was drawn from
 *   outside {@link withInitRandomnessAllowed}. A refused snapshot fails the
 *   version publish, so the alias stays on the previous version rather than
 *   serving a bad one. `Math.random` draws are only reported: libraries take
 *   one at import for sentinel strings and hash seeds all the time, and
 *   nothing that needs to be unique should be using it.
 *
 * The runtime and the handler are separate bundles, each with its own copy of
 * this module, so the state lives on `globalThis` where both see the same one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import nodeCrypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

export interface InitRandomnessUse {
  api: string;
  /** The innermost frames outside this module and Node's own code. */
  site: string;
}

interface SnapshotState {
  recording: boolean;
  uses: InitRandomnessUse[];
  /** Set while init runs code allowed to draw randomness; holds the reason. */
  allowed: AsyncLocalStorage<string>;
  pool: Uint32Array;
  poolIndex: number;
  /** `crypto.randomFillSync` as it was before it was wrapped. */
  fill: (buffer: Uint32Array) => Uint32Array;
}

const STATE_KEY = Symbol.for("infrawrench.lambda.snapshot");
const POOL_WORDS = 256;

function state(): SnapshotState {
  const global = globalThis as { [STATE_KEY]?: SnapshotState };
  global[STATE_KEY] ??= {
    recording: false,
    uses: [],
    allowed: new AsyncLocalStorage<string>(),
    pool: new Uint32Array(POOL_WORDS),
    poolIndex: POOL_WORDS,
    fill: nodeCrypto.randomFillSync,
  };
  return global[STATE_KEY];
}

function siteOf(stack: string): string {
  return stack
    .split("\n")
    .slice(1)
    .filter(
      (line) =>
        !line.includes("node:") && !/\bat (?:record|wrapped|snapshotSafeRandom)\b/.test(line),
    )
    .slice(0, 3)
    .map((line) => line.trim())
    .join(" < ");
}

function record(api: string): void {
  const s = state();
  if (!s.recording || s.allowed.getStore() !== undefined) return;
  s.uses.push({ api, site: siteOf(new Error().stack ?? "") });
}

/** `Math.random` from the CSPRNG: 52 random bits scaled into [0, 1). */
function snapshotSafeRandom(): number {
  record("Math.random");
  const s = state();
  if (s.poolIndex + 2 > POOL_WORDS) {
    s.fill(s.pool);
    s.poolIndex = 0;
  }
  const high = s.pool[s.poolIndex++]! >>> 12; // 20 bits
  const low = s.pool[s.poolIndex++]!; // 32 bits
  return (high * 0x1_0000_0000 + low) / 2 ** 52;
}

function wrap<T extends (...args: never[]) => unknown>(api: string, fn: T): T {
  return function wrapped(this: unknown, ...args: Parameters<T>) {
    record(api);
    return fn.apply(this, args);
  } as T;
}

/**
 * Make the process's randomness safe to snapshot and start recording what
 * init draws. Call first thing in the runtime, before any code that might
 * capture `Math.random` or call into `node:crypto` is loaded.
 */
export function prepareSnapshotRandomness(): void {
  const s = state();
  if (s.recording) return;
  s.recording = true;
  s.fill = nodeCrypto.randomFillSync;

  Math.random = snapshotSafeRandom;

  const randomUUID = nodeCrypto.randomUUID;
  override(nodeCrypto, "randomUUID", (options?: nodeCrypto.RandomUUIDOptions) =>
    randomUUID({ ...options, disableEntropyCache: true }),
  );
  // `getRandomValues` is left out: on the module it is a getter for Web
  // Crypto's, which is wrapped below.
  for (const api of ["randomBytes", "randomFillSync", "randomFill", "randomInt"] as const) {
    override(nodeCrypto, api, nodeCrypto[api] as (...args: never[]) => unknown);
  }
  // `import { randomUUID } from "node:crypto"` in the bundles reads the
  // module's live bindings, which only follow the object after this.
  syncBuiltinESMExports();

  // Web Crypto has its own methods; shadow them on the global instance.
  const web = globalThis.crypto;
  // Web Crypto's randomUUID shares Node's cache and takes no options.
  override(web, "randomUUID", () => randomUUID({ disableEntropyCache: true }));
  override(web, "getRandomValues", web.getRandomValues.bind(web));
}

/** Replace `target[key]` with a recording wrapper of `fn`, under the same name. */
function override(target: object, key: string, fn: (...args: never[]) => unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrap(`crypto.${key}`, fn),
  });
}

/**
 * Run init work that draws randomness it does not keep: an SDK call that
 * names its request with a UUID, say. Everything `fn` starts, synchronously
 * or not, is exempt from the snapshot check. A no-op wrapper outside a
 * SnapStart init.
 */
export function withInitRandomnessAllowed<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return state().allowed.run(reason, fn);
}

/** What init drew outside an allowed scope so far, for logs and tests. */
export function initRandomnessUses(): readonly InitRandomnessUse[] {
  return state().uses;
}

function describeSites(uses: readonly InitRandomnessUse[]): string {
  return [...new Set(uses.map((use) => `${use.api} at ${use.site}`))].join("\n  ");
}

/**
 * Stop recording and refuse the snapshot if init drew from `node:crypto` or
 * Web Crypto outside an allowed scope. Throws with every offending call site,
 * so the publish failure says what to fix. Returns a report of `Math.random`
 * draws, which do not block the snapshot, for the log; null when there were
 * none.
 */
export function assertSnapshotSafe(): string | null {
  const s = state();
  s.recording = false;
  const fatal = s.uses.filter((use) => use.api !== "Math.random");
  if (fatal.length > 0) {
    throw new Error(
      `Init drew randomness that a SnapStart snapshot would share between environments:\n  ${describeSites(fatal)}\n` +
        "Draw it in the handler (or load the module that does lazily, on first use); if the caller keeps " +
        "nothing derived from it, run it inside withInitRandomnessAllowed (server-core/src/runtime/lambda-snapshot.ts).",
    );
  }
  const soft = s.uses.filter((use) => use.api === "Math.random");
  return soft.length > 0
    ? `Init drew Math.random (shared by every environment restored from this snapshot):\n  ${describeSites(soft)}`
    : null;
}

/** After a restore: drop the `Math.random` buffer the snapshot carried. */
export function afterSnapshotRestore(): void {
  const s = state();
  s.pool = new Uint32Array(POOL_WORDS);
  s.poolIndex = POOL_WORDS;
}

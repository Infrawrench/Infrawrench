/**
 * Run a user-supplied regular expression without trusting it.
 *
 * V8's regex engine backtracks, so a pattern like `(?:a?){25}a{25}` takes
 * exponential time on a ~30 character input, and nothing interrupts a
 * synchronous `RegExp.test` on the calling thread. In the shared web and
 * poller processes that stalls every tenant's work at once. A static shape
 * check cannot close that (ambiguity is not a local property of a pattern),
 * so the match itself runs in a worker thread with a hard deadline: past it
 * the worker is terminated, which V8 honours mid-backtrack, and the caller
 * gets a {@link RegexTimeoutError} instead of a frozen event loop.
 *
 * One worker is kept warm and reused; requests are serialized through it, so
 * a timeout only ever kills the request that caused it. The worker source is
 * an inline string rather than a file so it survives the esbuild bundles of
 * web and poller unchanged. Node-only: not exported from the `./client`
 * barrel.
 */
import { Worker } from "node:worker_threads";

/** Default per-call deadline. Generous for any sane pattern over a few hundred lines. */
export const DEFAULT_REGEX_TIMEOUT_MS = 2000;

export class RegexTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Regular expression took longer than ${timeoutMs} ms to evaluate and was stopped; ` +
        "simplify the pattern (nested or adjacent optional/repeated parts backtrack exponentially)",
    );
    this.name = "RegexTimeoutError";
  }
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  let re;
  try {
    re = new RegExp(msg.source, msg.flags);
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: e && e.message ? e.message : String(e) });
    return;
  }
  const matched = msg.inputs.map((input) => re.test(input));
  parentPort.postMessage({ id: msg.id, matched });
});
`;

interface WorkerReply {
  id: number;
  matched?: boolean[];
  error?: string;
}

let worker: Worker | null = null;
let nextId = 1;
/** Tail of the serialization chain: each call waits for the previous one. */
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, {
    eval: true,
    // Bound memory too: a huge capture-heavy match should fail the request,
    // not the host process.
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
  });
  // Never keep the host process alive just for an idle worker.
  w.unref();
  const reset = () => {
    if (worker === w) worker = null;
  };
  w.on("exit", reset);
  w.on("error", reset);
  worker = w;
  return w;
}

function runOnce(
  source: string,
  flags: string,
  inputs: string[],
  timeoutMs: number,
): Promise<boolean[]> {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = nextId++;
    const cleanup = () => {
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
    };
    const onMessage = (reply: WorkerReply) => {
      if (reply.id !== id) return;
      cleanup();
      if (reply.error !== undefined) reject(new Error(`Invalid regex: ${reply.error}`));
      else resolve(reply.matched ?? []);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Regex worker exited unexpectedly"));
    };
    const timer = setTimeout(() => {
      cleanup();
      if (worker === w) worker = null;
      void w.terminate();
      reject(new RegexTimeoutError(timeoutMs));
    }, timeoutMs);
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    w.postMessage({ id, source, flags, inputs });
  });
}

/**
 * For each input, whether `new RegExp(source, flags)` matches it, evaluated
 * off the calling thread under a deadline that covers the whole batch.
 * Rejects with {@link RegexTimeoutError} past the deadline, or with an
 * `Invalid regex: …` error when the pattern does not compile. The stateful
 * `g`/`y` flags are dropped, since each input is tested independently.
 */
export function testRegexBounded(
  source: string,
  flags: string,
  inputs: string[],
  options?: { timeoutMs?: number },
): Promise<boolean[]> {
  if (inputs.length === 0) return Promise.resolve([]);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS;
  const safeFlags = flags.replace(/[gy]/g, "");
  const run = queue.then(() => runOnce(source, safeFlags, inputs, timeoutMs));
  queue = run.catch(() => undefined);
  return run;
}

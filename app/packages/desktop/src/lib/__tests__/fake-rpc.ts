/**
 * A stand-in for `src/lib/rpc/client.ts` in renderer tests, so a module that
 * calls the main process over Effect RPC can be tested without one:
 *
 *   vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
 *
 * and then answer the operations under test on {@link fakeRpc}:
 *
 *   fakeRpc.SshTunnelOpen = vi.fn(() => Effect.succeed({ tunnelId: "t1", localPort: 5000 }));
 *
 * Call sites keep their real shape (`runRpc(DesktopRpcClient.use((rpc) => rpc.X(p)))`,
 * `forkRpc(Effect.gen(...yield* DesktopRpcClient...))`); an operation the test
 * did not answer dies with its name.
 *
 * A module that calls the cloud through `cloudClient` (`../cloud-client.ts`)
 * reaches the client through `../rpc/desktop-client`, so mock that too, with
 * the same module, and answer the transport with {@link answerCloudHttp}:
 *
 *   vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
 */
import { vi } from "vitest";
import { Effect, Fiber, Predicate } from "effect";
import type {
  CloudHttpBytesResponse,
  CloudHttpRequest,
  CloudHttpResponse,
} from "../../../shared/rpc/groups/cloud-http";

type Operation = (...args: never[]) => unknown;

declare global {
  var __desktopFakeRpc: Record<string, Operation> | undefined;
}

/**
 * The fake client's operations, by RPC tag. Reset with {@link resetFakeRpc}.
 *
 * One registry per test file however many copies of this module the file
 * loads: after `vi.resetModules()` a dynamic import gets a fresh copy of this
 * module, while the mocked `../rpc/client` keeps the copy its factory first
 * loaded (Vitest does not reset the mock registry), and the two would
 * otherwise answer from different tables.
 */
export const fakeRpc: Record<string, Operation> = (globalThis.__desktopFakeRpc ??= {});

export function resetFakeRpc(): void {
  for (const tag of Object.keys(fakeRpc)) delete fakeRpc[tag];
}

const client = new Proxy(fakeRpc, {
  get(target, tag) {
    if (!Predicate.isString(tag)) return undefined;
    const operation = target[tag];
    if (operation) return operation;
    return () => Effect.die(new Error(`fake RPC: ${tag} was not answered by the test`));
  },
});

const DesktopRpcClient = Object.assign(Effect.succeed(client), {
  use: (f: (rpc: typeof client) => unknown) =>
    Effect.suspend(() => {
      const result = f(client);
      return Effect.isEffect(result) ? result : Effect.die(new Error("fake RPC: not an Effect"));
    }),
});

export const fakeRpcClientModule = {
  DesktopRpcClient,
  runRpc: (effect: Effect.Effect<unknown, unknown>) => Effect.runPromise(effect),
  forkRpc: (effect: Effect.Effect<unknown, unknown>) => {
    const fiber = Effect.runFork(effect);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  },
};

/**
 * Answer the `CloudHttp` transport with `answer(request)`: a status and a
 * JSON value (sent as its text), a status and a `text` body (a CSV, the
 * typings), or a status alone for an empty body. The returned mock records
 * each request as the main process would receive it, so a test can assert
 * the method, the encoded URL, the headers and the JSON body.
 */
export function answerCloudHttp(
  answer: (request: CloudHttpRequest) => {
    readonly status: number;
    readonly json?: unknown;
    readonly text?: string;
  },
) {
  const operation = vi.fn((request: CloudHttpRequest) => {
    const { status, json, text } = answer(request);
    const response: CloudHttpResponse = {
      status,
      body: text ?? (json === undefined ? "" : JSON.stringify(json)),
    };
    return Effect.succeed(response);
  });
  fakeRpc["CloudHttp"] = operation;
  return operation;
}

/**
 * Answer the `CloudHttpBytes` transport (an endpoint whose answer is binary:
 * a PDF, a ZIP) with a status and the body's bytes.
 */
export function answerCloudHttpBytes(
  answer: (request: CloudHttpRequest) => { readonly status: number; readonly bytes: Uint8Array },
) {
  const operation = vi.fn((request: CloudHttpRequest) => {
    const { status, bytes } = answer(request);
    const response: CloudHttpBytesResponse = { status, body: bytes };
    return Effect.succeed(response);
  });
  fakeRpc["CloudHttpBytes"] = operation;
  return operation;
}

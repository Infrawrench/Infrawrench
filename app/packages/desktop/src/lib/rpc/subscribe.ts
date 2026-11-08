/**
 * Hold a main-process push open for as long as the caller wants it: a
 * subscription RPC (host-key prompts, deep links, sign-in failures, OAuth
 * status changes) whose elements are handed to `onElement`.
 *
 * A subscription that ends or fails (the main process restarted its end, a
 * reload raced the connection) is logged and re-established a second later,
 * because while nothing is subscribed the main process treats the renderer as
 * absent. Returns the function that stops it for good.
 */
import { Effect, Stream } from "effect";
import { DesktopRpcClient, forkRpc } from "./client";

export function subscribeRpc<A, E>(
  label: string,
  open: (rpc: DesktopRpcClient["Service"]) => Stream.Stream<A, E>,
  onElement: (element: A) => void,
): () => void {
  return forkRpc(
    Effect.gen(function* () {
      const rpc = yield* DesktopRpcClient;
      yield* Stream.runForEach(open(rpc), (element) => Effect.sync(() => onElement(element)));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => console.error(`[${label}] subscription ended:`, cause)),
      ),
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
    ),
  );
}

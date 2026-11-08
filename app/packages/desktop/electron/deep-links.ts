// `infrawrench://open/<kind>?org=…` links from outside the app (the VS Code
// and Raycast extensions, a browser). The main process only routes them: the
// renderer parses the link with client-core's `parseDesktopDeepLink` (ESM,
// which this CommonJS graph would have to bridge) and opens the tab.
//
// The renderer's `DeepLinkHost` subscribes through the `DeepLinks` RPC stream
// (`shared/rpc/groups/deep-links.ts`). A link can arrive before any window is
// subscribed (a cold start from the link on macOS, argv on Windows/Linux, a
// window still loading), so the latest one is held and handed to the next
// subscriber first.
import { Context, Layer, Queue, Effect, Stream } from "effect";
import { PROTOCOL } from "../env";

const OPEN_PREFIX = `${PROTOCOL}://open/`;

let pending: string | null = null;

/** Subscribed renderers, oldest first: a link goes to the first one. */
const subscribers: Array<(url: string) => void> = [];

export function isDeepLink(url: string): boolean {
  return url.startsWith(OPEN_PREFIX);
}

export function deliverDeepLink(url: string): void {
  const subscriber = subscribers[0];
  if (!subscriber) {
    pending = url;
    return;
  }
  subscriber(url);
}

// Windows/Linux cold start: the link is in the first instance's argv.
const fromArgv = process.argv.find(isDeepLink);
if (fromArgv) pending = fromArgv;

export class DeepLinks extends Context.Service<
  DeepLinks,
  { readonly subscribe: Stream.Stream<string> }
>()("infrawrench/desktop/DeepLinks") {
  static readonly layer = Layer.succeed(DeepLinks)(
    DeepLinks.of({
      subscribe: Stream.callback<string>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const subscriber = (url: string) => {
              Queue.offerUnsafe(queue, url);
            };
            if (pending !== null) {
              subscriber(pending);
              pending = null;
            }
            subscribers.push(subscriber);
            return subscriber;
          }),
          (subscriber) =>
            Effect.sync(() => {
              const index = subscribers.indexOf(subscriber);
              if (index !== -1) subscribers.splice(index, 1);
            }),
        ),
      ),
    }),
  );
}

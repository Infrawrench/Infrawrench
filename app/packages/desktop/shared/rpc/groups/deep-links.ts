/**
 * `infrawrench://open/<kind>?org=…` links from outside the app (the VS Code
 * and Raycast extensions, a browser), routed to the renderer that opens them.
 *
 * The renderer's `DeepLinkHost` holds `DeepLinks` open for its life. A link
 * that arrives while nothing is subscribed (a cold start from the link, or a
 * window still loading) is held and is the first element the next
 * subscription receives. Each link goes to one subscriber.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export class DeepLinkRpcs extends RpcGroup.make(
  /** The raw URL; the renderer parses it with client-core's `parseDesktopDeepLink`. */
  Rpc.make("DeepLinks", { success: Schema.String, stream: true }),
) {}

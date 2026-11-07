import type { Dispatcher } from "undici";
import { BastionStreamOpenError } from "./errors.js";
import { hostMatches } from "./protocol.js";

/**
 * A bastion's allowlist is the union of every account bound to it, and the agent cannot
 * tell which account a stream is for. This is what keeps one account's calls to its own
 * plugin's hosts and its own configured host. It sits on the dispatcher rather than in
 * front of the request, so a redirect is judged too.
 */
export function scopeDispatcherToAccount(
  dispatcher: Dispatcher,
  bastionId: string,
  patterns: readonly string[],
): Dispatcher {
  return dispatcher.compose((dispatch) => (options, handler) => {
    const origin = new URL(String(options.origin));
    const host = origin.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!hostMatches(host, patterns)) {
      throw new BastionStreamOpenError(
        bastionId,
        `${host} is not allowed for this account: it is neither one of the plugin's hosts nor the account's own`,
      );
    }
    return dispatch(options, handler);
  });
}

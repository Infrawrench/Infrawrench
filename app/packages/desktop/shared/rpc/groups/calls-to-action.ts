/**
 * Calls to action: announcements read from a JSON file on the website and
 * shown once each, over the whole window, to installs that predate them.
 * `electron/calls-to-action.ts` has the file's format and the rules.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** What the primary button does. */
export const CallToActionAction = Schema.Union([
  /** Start the Infrawrench Cloud sign-in (shown only while signed out). */
  Schema.Struct({ type: Schema.Literal("sign-in") }),
  /** Open a web page in the system browser. */
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String }),
]);
export type CallToActionAction = typeof CallToActionAction.Type;

/** How the two buttons sit: a big button over small dismiss text, or a row. */
export const CallToActionLayout = Schema.Literals(["stacked", "side-by-side"]);
export type CallToActionLayout = typeof CallToActionLayout.Type;

/** One call to action, ready to show: conditions met, text in the user's locale. */
export const PendingCallToAction = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  action: CallToActionAction,
  /** The primary button's text; null uses the app's default for the action. */
  actionLabel: Schema.NullOr(Schema.String),
  /** The dismiss button's text; null uses the app's default. */
  dismissLabel: Schema.NullOr(Schema.String),
  layout: CallToActionLayout,
});
export type PendingCallToAction = typeof PendingCallToAction.Type;

export class CallToActionRpcs extends RpcGroup.make(
  /**
   * The calls to action to show now, oldest first. Never fails: an
   * unreachable or malformed file shows nothing.
   */
  Rpc.make("CallsToActionPending", {
    payload: {
      /** Signed in to Infrawrench Cloud (`when.account`). */
      signedIn: Schema.Boolean,
      /** The UI locale, for `translations`. */
      locale: Schema.String,
    },
    success: Schema.Array(PendingCallToAction),
  }),
  /** The user acted on or dismissed one: it never shows again. */
  Rpc.make("CallsToActionComplete", {
    payload: { id: Schema.String },
  }),
) {}

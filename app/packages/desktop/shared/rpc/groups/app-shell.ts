/**
 * The app shell: what keeps the app alive with its window closed, native
 * notifications, the open dialog, the system browser, the clipboard image
 * and installing a downloaded update.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** The subset of Electron's `OpenDialogOptions` the renderer passes. */
export const OpenDialogOptions = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  defaultPath: Schema.optionalKey(Schema.String),
  buttonLabel: Schema.optionalKey(Schema.String),
  filters: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          extensions: Schema.mutable(Schema.Array(Schema.String)),
        }),
      ),
    ),
  ),
  properties: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Literals([
          "openFile",
          "openDirectory",
          "multiSelections",
          "showHiddenFiles",
          "createDirectory",
          "promptToCreate",
          "noResolveAliases",
          "treatPackageAsDirectory",
          "dontAddToRecent",
        ]),
      ),
    ),
  ),
});
export type OpenDialogOptions = typeof OpenDialogOptions.Type;

/** Every path in `filePaths` may then be read or written by the download calls. */
export const OpenDialogResult = Schema.Struct({
  canceled: Schema.Boolean,
  filePaths: Schema.Array(Schema.String),
});
export type OpenDialogResult = typeof OpenDialogResult.Type;

export const ClipboardImage = Schema.Struct({ pngBase64: Schema.String, mime: Schema.String });
export type ClipboardImage = typeof ClipboardImage.Type;

/** A URL the system browser may not open: unparseable, or not http(s)/mailto. */
export class ExternalUrlRefused extends Schema.TaggedError<ExternalUrlRefused>()(
  "ExternalUrlRefused",
  { message: Schema.String },
) {}

export class AppShellRpcs extends RpcGroup.make(
  /**
   * How many metric pings the renderer is polling. While pings or enabled
   * crons are active, closing the last window hides it instead of quitting.
   */
  Rpc.make("AppSetPingsActive", { payload: { count: Schema.Finite } }),
  Rpc.make("AppSetCronsActive", { payload: { count: Schema.Finite } }),
  /** Restart into a downloaded update; a no-op when none is staged. */
  Rpc.make("AppInstallUpdateNow"),
  /** A native notification; clicking it brings the window forward. */
  Rpc.make("AppShowNotification", { payload: { title: Schema.String, body: Schema.String } }),
  Rpc.make("AppShowOpenDialog", { payload: OpenDialogOptions, success: OpenDialogResult }),
  Rpc.make("AppOpenExternalUrl", {
    payload: { url: Schema.String },
    error: ExternalUrlRefused,
  }),
  /**
   * The clipboard's image as PNG, or null. The renderer cannot use
   * `navigator.clipboard.read()` (Electron fails its permission check).
   */
  Rpc.make("AppReadClipboardImage", { success: Schema.NullOr(ClipboardImage) }),
) {}

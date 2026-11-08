/**
 * The `infrawrench` shell command: whether the CLI shim is installed on the
 * user's PATH, and installing or removing it.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const ShellCommandStatus = Schema.Struct({
  installed: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  /** Installed, but pointing at a different app binary (an older install). */
  stale: Schema.Boolean,
});
export type ShellCommandStatus = typeof ShellCommandStatus.Type;

export const ShellCommandInstallResult = Schema.Struct({
  path: Schema.String,
  /** A follow-up the user still has to do (add the dir to PATH, open a new shell). */
  note: Schema.NullOr(Schema.String),
});
export type ShellCommandInstallResult = typeof ShellCommandInstallResult.Type;

/** Why the shim could not be written or removed, in a sentence for the toast. */
export class ShellCommandError extends Schema.TaggedError<ShellCommandError>()(
  "ShellCommandError",
  { message: Schema.String },
) {}

export class ShellCommandRpcs extends RpcGroup.make(
  Rpc.make("ShellCommandStatus", { success: ShellCommandStatus }),
  Rpc.make("ShellCommandInstall", {
    success: ShellCommandInstallResult,
    error: ShellCommandError,
  }),
  Rpc.make("ShellCommandUninstall", {
    success: Schema.NullOr(Schema.String),
    error: ShellCommandError,
  }),
) {}

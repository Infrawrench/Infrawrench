/**
 * Interactive SSH shells over ssh2 in the main process.
 *
 * A session is one streaming call: {@link SshShellRpcs} `SshShellOpen` dials
 * the chain, opens the PTY and streams `Opened` (carrying the id the input
 * calls address) followed by the shell's output. The stream ends when the
 * remote shell exits. Interrupting it, which is what closing the terminal
 * does, and the renderer going away (a reload, a closed window) both close
 * the stream's scope, and that is what releases the SSH channel and its
 * connections: there is no separate kill call to forget.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { SshError, SshShellConfig } from "./ssh-common";

export const SshShellEvent = Schema.Union([
  /** The shell is open; `shellId` addresses `SshShellWrite` and `SshShellResize`. */
  Schema.TaggedStruct("Opened", { shellId: Schema.String }),
  /** Bytes from the shell's stdout or stderr, in the order they arrived. */
  Schema.TaggedStruct("Data", { data: Schema.Uint8Array }),
]);
export type SshShellEvent = typeof SshShellEvent.Type;

export class SshShellRpcs extends RpcGroup.make(
  Rpc.make("SshShellOpen", {
    payload: SshShellConfig,
    success: SshShellEvent,
    error: SshError,
    stream: true,
  }),
  /** Keystrokes for an open shell. A shell this renderer does not own is ignored. */
  Rpc.make("SshShellWrite", {
    payload: { shellId: Schema.String, data: Schema.String },
  }),
  Rpc.make("SshShellResize", {
    payload: { shellId: Schema.String, cols: Schema.Finite, rows: Schema.Finite },
  }),
) {}

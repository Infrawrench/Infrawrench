/**
 * SSH host-key trust prompts: the main process asks the user whether to pin
 * an unknown host key, or replace a pin whose key changed.
 *
 * Effect RPC has no server-to-client request, so the question travels as a
 * subscription: each window's prompt host holds `SshHostKeyPrompts` open for
 * its life and answers with `SshHostKeyDecide`. A prompt asked while no
 * window is subscribed is denied at once (fail closed), and a prompt answered
 * in one window is withdrawn from the others with `Settled`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { HostKeyPromptPayload } from "@infrawrench/plugin-base";
import { exact } from "../exact";

export const HostKeyPrompt = exact<HostKeyPromptPayload>()(
  Schema.Struct({
    requestId: Schema.String,
    host: Schema.String,
    port: Schema.Finite,
    kind: Schema.Literals(["first-connect", "mismatch"]),
    presentedFingerprint: Schema.String,
    storedFingerprint: Schema.optionalKey(Schema.String),
  }),
);

export const HostKeyPromptEvent = Schema.Union([
  Schema.TaggedStruct("Prompt", { prompt: HostKeyPrompt }),
  /** Answered (here or in another window) or timed out: stop showing it. */
  Schema.TaggedStruct("Settled", { requestId: Schema.String }),
]);
export type HostKeyPromptEvent = typeof HostKeyPromptEvent.Type;

export class SshHostKeyRpcs extends RpcGroup.make(
  /** Prompts still waiting when the subscription starts come first. */
  Rpc.make("SshHostKeyPrompts", { success: HostKeyPromptEvent, stream: true }),
  /** The user's answer. An unknown or already-settled `requestId` is ignored. */
  Rpc.make("SshHostKeyDecide", {
    payload: { requestId: Schema.String, accept: Schema.Boolean },
  }),
) {}

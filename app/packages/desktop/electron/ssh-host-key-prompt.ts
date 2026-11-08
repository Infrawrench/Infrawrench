/**
 * Interactive SSH host-key prompt: asks the renderer whether to trust an
 * unknown host key (first connect) or a key that no longer matches its pin
 * (mismatch), and waits for the answer.
 *
 * Every window's `SshHostKeyPromptHost` subscribes through the
 * `SshHostKeyPrompts` RPC stream ({@link SshHostKeyPrompts}) and answers with
 * `SshHostKeyDecide`. Effect RPC has no server-to-client request, and a
 * subscription is what one looks like: the question is a stream element, the
 * answer an ordinary call. Used by ssh-host-keys.ts and the cloud host-key
 * trust flow (`cloud-data/host-key-trust.ts`, `cloud-data/shared.ts`).
 */
import * as crypto from "node:crypto";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import type { HostKeyPromptKind, HostKeyPromptPayload } from "@infrawrench/plugin-base";
import type { HostKeyPromptEvent } from "../shared/rpc/groups/ssh-host-keys";

interface Pending {
  readonly prompt: HostKeyPromptPayload;
  readonly resolve: (accept: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
const subscribers = new Set<(event: HostKeyPromptEvent) => void>();

/**
 * How long we wait for the user to respond before treating the prompt as
 * denied. Long enough that a user who steps away briefly still gets to make
 * the call, short enough that abandoned prompts don't pin a tunnel open.
 */
const PROMPT_TIMEOUT_MS = 60_000;

function publish(event: HostKeyPromptEvent): void {
  for (const subscriber of subscribers) subscriber(event);
}

function settle(requestId: string, accept: boolean): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  publish({ _tag: "Settled", requestId });
  entry.resolve(accept);
}

export function promptHostKeyDecision(input: {
  host: string;
  port: number;
  kind: HostKeyPromptKind;
  presentedFingerprint: string;
  storedFingerprint?: string;
}): Promise<boolean> {
  if (subscribers.size === 0) {
    // No window to ask. Fail closed so the connection is rejected rather
    // than silently trusting an unknown key.
    console.warn(
      `[ssh] no renderer window available to confirm host key for ${input.host}:${input.port}, denying.`,
    );
    return Promise.resolve(false);
  }
  const requestId = crypto.randomUUID();
  const prompt: HostKeyPromptPayload = { ...input, requestId };
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      console.warn(`[ssh] host-key prompt for ${input.host}:${input.port} timed out, denying.`);
      settle(requestId, false);
    }, PROMPT_TIMEOUT_MS);
    pending.set(requestId, { prompt, resolve, timer });
    publish({ _tag: "Prompt", prompt });
  });
}

/** The prompts and the answers, as the RPC handlers serve them. */
export class SshHostKeyPrompts extends Context.Service<
  SshHostKeyPrompts,
  {
    /** Prompts still waiting first, then each new prompt and each settlement. */
    readonly subscribe: Stream.Stream<HostKeyPromptEvent>;
    readonly decide: (requestId: string, accept: boolean) => Effect.Effect<void>;
  }
>()("infrawrench/desktop/SshHostKeyPrompts") {
  static readonly layer = Layer.succeed(SshHostKeyPrompts)(
    SshHostKeyPrompts.of({
      subscribe: Stream.callback<HostKeyPromptEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const subscriber = (event: HostKeyPromptEvent) => {
              Queue.offerUnsafe(queue, event);
            };
            for (const { prompt } of pending.values()) subscriber({ _tag: "Prompt", prompt });
            subscribers.add(subscriber);
            return subscriber;
          }),
          (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
        ),
      ),
      decide: (requestId, accept) => Effect.sync(() => settle(requestId, accept)),
    }),
  );
}

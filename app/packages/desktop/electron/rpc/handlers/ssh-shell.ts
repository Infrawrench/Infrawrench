/**
 * Interactive shells and the host-key prompts their connections raise: the
 * two SSH groups whose calls are streams.
 */
import { Effect, Layer } from "effect";
import { SshHostKeyRpcs } from "../../../shared/rpc/groups/ssh-host-keys";
import { SshShellRpcs } from "../../../shared/rpc/groups/ssh-shell";
import { SshHostKeyPrompts } from "../../ssh-host-key-prompt";
import { SshShells } from "../../ssh-shell";

export const SshShellHandlers = SshShellRpcs.toLayer(
  Effect.gen(function* () {
    const shells = yield* SshShells;
    return SshShellRpcs.of({
      // The stream's scope owns the channel and every hop: the server closes
      // it when the stream ends, the renderer interrupts it, or the renderer's
      // connection goes.
      SshShellOpen: (config, { client }) => shells.open(config, client.id),
      SshShellWrite: ({ shellId, data }, { client }) => shells.write(shellId, client.id, data),
      SshShellResize: ({ shellId, cols, rows }, { client }) =>
        shells.resize(shellId, client.id, cols, rows),
    });
  }),
).pipe(Layer.provide(SshShells.layer));

export const SshHostKeyHandlers = SshHostKeyRpcs.toLayer(
  Effect.gen(function* () {
    const prompts = yield* SshHostKeyPrompts;
    return SshHostKeyRpcs.of({
      SshHostKeyPrompts: () => prompts.subscribe,
      SshHostKeyDecide: ({ requestId, accept }) => prompts.decide(requestId, accept),
    });
  }),
).pipe(Layer.provide(SshHostKeyPrompts.layer));

import { Effect, Layer } from "effect";
import { WorkflowRpcs } from "../../../shared/rpc/groups/workflows";
import { WorkflowRunner } from "../../workflow-host";
import { WorkflowSecrets } from "../../workflow-secrets";

export const WorkflowHandlers = WorkflowRpcs.toLayer(
  Effect.gen(function* () {
    const runner = yield* WorkflowRunner;
    const secrets = yield* WorkflowSecrets;
    return WorkflowRpcs.of({
      WorkflowRun: (request) => runner.run(request),
      WorkflowStop: ({ runToken }) => runner.stop(runToken),
      WorkflowHostReply: (reply) => runner.reply(reply),
      WorkflowSecretsList: () => secrets.list,
      WorkflowSecretUpsert: (input) => secrets.upsert(input),
      WorkflowSecretDelete: ({ id }) => secrets.remove(id),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(WorkflowRunner.layer, WorkflowSecrets.layer)));

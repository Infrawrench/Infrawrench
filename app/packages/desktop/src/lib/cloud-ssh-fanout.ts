/**
 * Renderer bridge for the cloud fan-out SSH API (`/api/org/:orgId/ssh-fanout`),
 * typed calls to the contract's `sshFanout` domain over the cloud transport.
 * The run call keeps the change-freeze 423 as data (not an exception) so the
 * shared `SshFanoutView` can offer the override affordance, which resends
 * with the `x-change-freeze-override` header the endpoint declares.
 */
import type { FanoutHostResult } from "@infrawrench/client-core";
import type { SshFanoutSnippetInfo, SshFanoutTargetInfo } from "@infrawrench/ui";
import { Effect, Option } from "effect";
import { cloudClient, CloudResponseError, serverErrorSentence } from "./cloud-client";
import { definedFields } from "./cloud-payload";
import { runRpc } from "./rpc/client";

const fanout = () => cloudClient("sshFanout").sshFanout;

export function listCloudFanoutTargets(orgId: string): Promise<SshFanoutTargetInfo[]> {
  return runRpc(
    fanout()
      .targets({ params: { orgId } })
      .pipe(Effect.map((res) => res.targets)),
  );
}

export function listCloudFanoutSnippets(orgId: string): Promise<SshFanoutSnippetInfo[]> {
  return runRpc(
    fanout()
      .listSnippets({ params: { orgId } })
      .pipe(Effect.map((res) => res.snippets)),
  );
}

export async function createCloudFanoutSnippet(
  orgId: string,
  body: { name: string; command: string },
): Promise<void> {
  await runRpc(fanout().createSnippet({ params: { orgId }, payload: body }));
}

export async function deleteCloudFanoutSnippet(orgId: string, id: string): Promise<void> {
  await runRpc(fanout().deleteSnippet({ params: { orgId, id } }));
}

export type CloudFanoutRunResult =
  { kind: "results"; results: FanoutHostResult[] } | { kind: "freeze"; message: string };

export function runCloudFanout(
  orgId: string,
  body: {
    command: string;
    targets: Array<{ kind: "account" | "resource"; id: string }>;
    sshKeyId?: string | undefined;
    username?: string | undefined;
  },
  overrideFreeze: boolean,
): Promise<CloudFanoutRunResult> {
  return runRpc(
    fanout()
      .run({
        params: { orgId },
        headers: overrideFreeze ? { "x-change-freeze-override": "true" } : {},
        payload: definedFields(body),
      })
      .pipe(
        Effect.map((res): CloudFanoutRunResult => ({ kind: "results", results: res.results })),
        Effect.catchTag("CloudResponseError", (error) => {
          const sentence = serverErrorSentence(error.body);
          // A freeze is an answer the view offers to override, not a failure.
          if (error.status === 423) {
            return Effect.succeed<CloudFanoutRunResult>({
              kind: "freeze",
              message: Option.getOrElse(sentence, () => "Blocked by an active change freeze"),
            });
          }
          return Effect.fail(
            new CloudResponseError({
              message: Option.getOrElse(sentence, () => "Fan-out run failed"),
              status: error.status,
              body: error.body,
            }),
          );
        }),
      ),
  );
}

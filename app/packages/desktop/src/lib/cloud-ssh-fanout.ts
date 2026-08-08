/**
 * Renderer bridge for the cloud fan-out SSH API (`/api/org/:orgId/ssh-fanout`).
 * The run call keeps the change-freeze 423 as data (not an exception) so the
 * shared `SshFanoutView` can offer the override affordance.
 */
import type { FanoutHostResult } from "@infrawrench/client-core";
import type { SshFanoutSnippetInfo, SshFanoutTargetInfo } from "@infrawrench/ui";
import { invoke } from "./invoke";

export async function listCloudFanoutTargets(orgId: string): Promise<SshFanoutTargetInfo[]> {
  const res = await invoke<{ targets: SshFanoutTargetInfo[] }>("cloud_ssh_fanout_targets", {
    orgId,
  });
  return res?.targets ?? [];
}

export async function listCloudFanoutSnippets(orgId: string): Promise<SshFanoutSnippetInfo[]> {
  const res = await invoke<{ snippets: SshFanoutSnippetInfo[] }>("cloud_ssh_fanout_snippets_list", {
    orgId,
  });
  return res?.snippets ?? [];
}

export async function createCloudFanoutSnippet(
  orgId: string,
  body: { name: string; command: string },
): Promise<void> {
  await invoke("cloud_ssh_fanout_snippets_create", { orgId, body });
}

export async function deleteCloudFanoutSnippet(orgId: string, id: string): Promise<void> {
  await invoke("cloud_ssh_fanout_snippets_delete", { orgId, id });
}

export type CloudFanoutRunResult =
  { kind: "results"; results: FanoutHostResult[] } | { kind: "freeze"; message: string };

export async function runCloudFanout(
  orgId: string,
  body: {
    command: string;
    targets: Array<{ kind: "account" | "resource"; id: string }>;
    sshKeyId?: string | undefined;
    username?: string | undefined;
  },
  overrideFreeze: boolean,
): Promise<CloudFanoutRunResult> {
  const res = await invoke<{ status: number; body: unknown }>("cloud_ssh_fanout_run", {
    orgId,
    body,
    overrideFreeze,
  });
  const parsed = (res?.body ?? {}) as Record<string, unknown>;
  if (res?.status === 423) {
    const message =
      typeof parsed["error"] === "string"
        ? (parsed["error"] as string)
        : "Blocked by an active change freeze";
    return { kind: "freeze", message };
  }
  if (res?.status !== 200) {
    const message =
      typeof parsed["error"] === "string" ? (parsed["error"] as string) : "Fan-out run failed";
    throw new Error(message);
  }
  return { kind: "results", results: (parsed["results"] as FanoutHostResult[]) ?? [] };
}

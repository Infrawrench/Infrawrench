/**
 * The programs a cloud job's machine needs for what the job is lent: `ssh`
 * for an SSH key or an SSH host entry, `kubectl` for a kubeconfig.
 *
 * A job on the runner lists them itself (`tools: [builtin:kubectl@1.37]`). A
 * cloud job cannot, and runs on an image of the pipeline's choosing, so the
 * job script puts them there (`bootstrap.ts`). Which programs those are is
 * the lending plugin's to say (`manifest.ciCredential.tools`); the host only
 * adds OpenSSH's client for the SSH keys it lends itself.
 */
import { CI_OPENSSH_CLIENT, type CiToolDeclaration } from "@infrawrench/plugin-base";

import type { CiJobAccess } from "../db/schema.js";

/**
 * What one job names, out of a run's access list. A matrix or package job's
 * id is its key and a suffix in brackets (`deploy[eu]`); the same key in
 * another pipeline is another job, unless the run has no entry for this one.
 */
export function accessOfJob(
  access: readonly CiJobAccess[] | null,
  job: { job: string; pipeline: string },
): CiJobAccess[] {
  const mine = (access ?? []).filter((a) => job.job === a.job || job.job.startsWith(`${a.job}[`));
  const same = mine.filter((a) => a.pipeline === job.pipeline);
  return same.length > 0 ? same : mine;
}

/**
 * The tools for what a job names, each command once: every lent
 * connection's plugin's, then OpenSSH's client when it is lent an SSH key.
 */
export function toolsOfJob(
  entries: readonly CiJobAccess[],
  /** The plugins of the organization's connections with this name. */
  pluginsOf: (connection: string) => readonly string[],
  /** `manifest.ciCredential.tools` of a plugin. */
  declared: (pluginId: string) => readonly CiToolDeclaration[],
): CiToolDeclaration[] {
  const out = new Map<string, CiToolDeclaration>();
  const add = (tool: CiToolDeclaration) => {
    if (!out.has(tool.command)) out.set(tool.command, tool);
  };
  for (const entry of entries) {
    for (const connection of entry.connections ?? []) {
      for (const pluginId of pluginsOf(connection.name)) declared(pluginId).forEach(add);
    }
    if ((entry.sshKeys?.length ?? 0) > 0) add(CI_OPENSSH_CLIENT);
  }
  return [...out.values()];
}

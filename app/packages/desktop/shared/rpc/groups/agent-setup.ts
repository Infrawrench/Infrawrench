/**
 * Coding-agent VM setup (`electron/agent-setup.ts`): plan a session from the
 * local repository, sync the repo and the agent's config files to the VM
 * over SFTP, and fetch the agent's branch back as a git bundle.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { AgentSetupPlan as AgentSetupPlanType } from "@infrawrench/ui/agents";
import { exact } from "../exact";
import { SshHostConfig } from "./ssh-common";

/** Why a setup step failed, in the sentence the session log shows. */
export class AgentSetupError extends Schema.TaggedError<AgentSetupError>()("AgentSetupError", {
  message: Schema.String,
}) {}

const AgentTool = Schema.Literals(["codex", "claude-code"]);

const StringMap = Schema.Record(Schema.String, Schema.String);

const AgentRepoResourceSpec = Schema.Struct({
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  account: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(StringMap),
  env: Schema.optionalKey(StringMap),
});

export const AgentSetupPlan = exact<AgentSetupPlanType>()(
  Schema.Struct({
    source: Schema.Literals(["git-url", "local-folder"]),
    workspaceName: Schema.String,
    initialCloneUrl: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    runtimes: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          language: Schema.Literals(["node", "php", "ruby", "go"]),
          version: Schema.String,
          versionSource: Schema.Literals(["project", "latest"]),
          source: Schema.String,
          reasons: Schema.mutable(Schema.Array(Schema.String)),
        }),
      ),
    ),
    packageManagers: Schema.mutable(Schema.Array(Schema.String)),
    configSources: Schema.mutable(
      Schema.Array(
        Schema.Struct({ label: Schema.String, localPath: Schema.String, exists: Schema.Boolean }),
      ),
    ),
    warnings: Schema.mutable(Schema.Array(Schema.String)),
    repoConfig: Schema.optionalKey(
      Schema.Struct({
        env: Schema.optionalKey(StringMap),
        resources: Schema.optionalKey(Schema.mutable(Schema.Array(AgentRepoResourceSpec))),
      }),
    ),
  }),
);

export const AgentSyncFilesResult = Schema.Struct({
  repoFiles: Schema.Finite,
  configFiles: Schema.Finite,
  warnings: Schema.Array(Schema.String),
});

export class AgentSetupRpcs extends RpcGroup.make(
  Rpc.make("AgentPlanSetup", {
    payload: { repoPath: Schema.String, tool: AgentTool, workspaceName: Schema.String },
    success: AgentSetupPlan,
    error: AgentSetupError,
  }),
  Rpc.make("AgentSyncFiles", {
    payload: {
      config: SshHostConfig,
      tool: AgentTool,
      remoteHome: Schema.String,
      projectDir: Schema.String,
      repoPath: Schema.optionalKey(Schema.String),
    },
    success: AgentSyncFilesResult,
    error: AgentSetupError,
  }),
  Rpc.make("AgentReconcileFetch", {
    payload: {
      config: SshHostConfig,
      workspaceName: Schema.String,
      branchName: Schema.String,
      repoPath: Schema.String,
    },
    success: Schema.Struct({ message: Schema.String }),
    error: AgentSetupError,
  }),
) {}

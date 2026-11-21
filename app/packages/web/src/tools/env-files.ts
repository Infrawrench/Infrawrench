/**
 * Environment file tools: the MCP/chat view of the Environment files tab.
 *
 * They let an assistant write a project's `.infraenv` (find the resources
 * whose outputs fill each variable, check the file, and commit it to the
 * repository as a pull request) without ever putting a secret in the file.
 * Permissions mirror the routes. Resolving hands out secret values, so it
 * always waits for the user's approval in chat, the `get_resource_outputs`
 * stance.
 */
import { Schema } from "effect";
import { INFRAENV_LIMITS } from "@infrawrench/client-core";
import {
  EnvFileNotFound,
  EnvFileRefused,
  commitInfraenvFile,
  describeInfraenv,
  listInfraenvRepos,
  listInfraenvSources,
  readInfraenvRepoFile,
  resolveInfraenv,
} from "@infrawrench/server-core/env-files/service";
import { checkEnvFileForCi } from "@infrawrench/server-core/ci/env-file";
import {
  GithubApiError,
  getBranchSha,
  getDefaultBranch,
  isRepoFullName,
} from "@infrawrench/server-core/github/issues-api";
import { orgInstallationIds } from "@infrawrench/server-core/github-issues/settings";
import { err, ok, type ToolDefinition } from "./types";

function failure(e: unknown) {
  if (e instanceof EnvFileRefused || e instanceof EnvFileNotFound || e instanceof GithubApiError) {
    return err(e.message);
  }
  throw e;
}

const FORMAT =
  "`.infraenv` is a dotenv superset committed to the repository in place of `.env`. Sections: " +
  "`[infrawrench]` (`org = <org id>`, `output = .env`), `[env]` (shared by every environment) " +
  "and `[env.<name>]` (overrides), plus `[vars]` / `[vars.<name>]` substitutions. Each line is " +
  "`KEY = value` where value is a literal, " +
  '`resource("<plugin>/<type>", "<display name>", "<outputKey>")` (an output of a synced ' +
  "resource found by name, so the file works in any organization; `<plugin>/<type>@<account>` " +
  'narrows it to one account), `resource("<resourceId>", "<outputKey>")` (pinned by id), or ' +
  '`secret("<NAME>")` (an organization secret; create one with write_workflow_secret). ' +
  "`${name}` inside reference arguments is replaced from [vars] (the built-in `environment` is " +
  "the environment's name). Prefer references by name. A quoted value is always a literal. Never write a secret value into " +
  "the file: reference it. A `# comment` line above a reference naming the resource keeps " +
  "reviews readable.";

const vars = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.String).annotate({
    description:
      "Substitutions laid over the file's [vars] and [vars.<environment>], for `${name}` in reference arguments.",
  }),
);

const source = Schema.String.check(Schema.isMaxLength(INFRAENV_LIMITS.maxSourceLength)).annotate({
  description: "The .infraenv text.",
});

const repoInput = {
  installationId: Schema.Number.annotate({
    description: "The GitHub App installation id (from list_env_file_repos).",
  }),
  repo: Schema.String.annotate({ description: "`owner/name`." }),
  path: Schema.String.annotate({ description: "Path in the repository, e.g. `.infraenv`." }),
};

export function envFileTools(): ToolDefinition[] {
  return [
    {
      name: "list_env_sources",
      title: "Find resources for .infraenv variables",
      description:
        "Synced resources whose outputs can fill an .infraenv variable (connection strings, " +
        "hosts, API keys, secret manager values), each with its resource id, outputs and a " +
        "suggested variable name. Use the resource id and an output key in " +
        `resource("<id>", "<output>"). ${FORMAT}`,
      inputSchema: {
        q: Schema.optionalKey(
          Schema.String.annotate({ description: "Matches name, id, type or account." }),
        ),
        limit: Schema.optionalKey(Schema.Number.annotate({ description: "1-100, default 50." })),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { q, limit } = input as { q?: string; limit?: number };
        return ok({ sources: await listInfraenvSources(auth.organizationId, { q, limit }) });
      },
    },
    {
      name: "describe_env_file",
      title: "Check an .infraenv file",
      description:
        "Parse an .infraenv and look up every reference: which resource, account and output " +
        "each resource() names, whether each secret() exists and has a value, and every " +
        `problem with its line. Reads no values. Run it before committing. ${FORMAT}`,
      inputSchema: { source, vars },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const args = input as { source: string; vars?: Record<string, string> };
        return ok(await describeInfraenv(auth.organizationId, args.source, { vars: args.vars }));
      },
    },
    {
      name: "resolve_env_file",
      title: "Resolve an .infraenv into .env values",
      description:
        "Resolve one environment of an .infraenv into the values its .env would hold, in " +
        "plaintext, plus the generated .env text. Returns secrets: always waits for the user's " +
        "approval in chat. Prefer describe_env_file when you only need to check the file.",
      inputSchema: {
        source,
        vars,
        environment: Schema.optionalKey(
          Schema.String.annotate({
            description: "An [env.<name>] section to lay over [env]. Omit for [env] alone.",
          }),
        ),
      },
      risk: "read",
      openWorld: true,
      permission: "secrets:read",
      requiresApproval: async () => true,
      handler: async (input, auth) => {
        const args = input as {
          source: string;
          environment?: string;
          vars?: Record<string, string>;
        };
        try {
          return ok(
            await resolveInfraenv(auth.organizationId, {
              source: args.source,
              environment: args.environment ?? null,
              vars: args.vars,
            }),
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "check_ci_env_file",
      title: "Check what an Infrawrench CI job gets from an .infraenv",
      description:
        "What a job with `env-file:` would get from a repository's .infraenv on a branch, without " +
        "running anything or reading any value: for each variable, a literal, a resource output " +
        "and the CI grant that covers it, or a CI secret by name; or why the job would fail on it " +
        "(no such resource, an ambiguous name, not granted to CI for this repository and branch, " +
        "an output the grant does not tick, a substitution with no value). In CI, `secret()` reads " +
        "the repository's CI secrets, not the organization's secrets: check those names with " +
        "list_ci_values. Get `installationId` from list_ci_repositories.",
      inputSchema: {
        installationId: Schema.Number.annotate({
          description: "The GitHub App installation, from list_ci_repositories.",
        }),
        repo: Schema.String.annotate({ description: "`owner/name`." }),
        branch: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "The branch the job runs on (grants can be per branch). Default: the default branch.",
          }),
        ),
        path: Schema.optionalKey(Schema.String.annotate({ description: "Default `.infraenv`." })),
        environment: Schema.optionalKey(
          Schema.String.annotate({ description: "The job's `env-file.environment`." }),
        ),
        vars,
      },
      risk: "read",
      openWorld: true,
      permission: "ci:read",
      handler: async (input, auth) => {
        const args = input as {
          installationId: number;
          repo: string;
          branch?: string;
          path?: string;
          environment?: string;
          vars?: Record<string, string>;
        };
        if (!isRepoFullName(args.repo)) return err("repo must be `owner/name`.");
        if (!(await orgInstallationIds(auth.organizationId)).has(args.installationId)) {
          return err("That GitHub installation is not connected to this organization.");
        }
        try {
          const branch =
            args.branch?.trim() || (await getDefaultBranch(args.installationId, args.repo));
          const sha = await getBranchSha(args.installationId, args.repo, branch);
          const check = await checkEnvFileForCi(
            {
              id: "check",
              organizationId: auth.organizationId,
              repoFullName: args.repo,
              event: "push",
              headRef: branch,
              fromFork: false,
              installationId: args.installationId,
              sha,
            },
            {
              path: args.path?.trim() || ".infraenv",
              ...(args.environment ? { environment: args.environment } : {}),
              ...(args.vars ? { vars: args.vars } : {}),
            },
          );
          return ok({ branch, sha, ...check });
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "list_env_file_repos",
      title: "List repositories for .infraenv files",
      description:
        "Repositories the organization's GitHub App installations reach, with each one's " +
        "installation id and default branch, for read_env_file and commit_env_file.",
      inputSchema: {},
      risk: "read",
      openWorld: true,
      permission: "github-issues:read",
      handler: async (_input, auth) => ok(await listInfraenvRepos(auth.organizationId)),
    },
    {
      name: "read_env_file",
      title: "Read an .infraenv from a repository",
      description:
        "The file's text and blob sha on a branch (the default branch when omitted). " +
        "`content` is null when the file does not exist yet. Pass the sha to commit_env_file.",
      inputSchema: {
        ...repoInput,
        branch: Schema.optionalKey(Schema.String),
      },
      risk: "read",
      openWorld: true,
      permission: "github-issues:read",
      handler: async (input, auth) => {
        try {
          return ok(
            await readInfraenvRepoFile(
              auth.organizationId,
              input as { installationId: number; repo: string; path: string; branch?: string },
            ),
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "commit_env_file",
      title: "Commit an .infraenv to a repository",
      description:
        "Write the file to a repository as the GitHub App: one commit on the branch, or a new " +
        "branch with a pull request (the default; a person reviews and merges it). The text must " +
        "parse. `sha` is what read_env_file returned (null for a new file); a file changed since " +
        `is refused rather than overwritten. ${FORMAT}`,
      inputSchema: {
        ...repoInput,
        content: source,
        sha: Schema.NullOr(Schema.String),
        branch: Schema.optionalKey(
          Schema.String.annotate({ description: "Default: the repository's default branch." }),
        ),
        mode: Schema.optionalKey(
          Schema.Literals(["pull-request", "commit"]).annotate({
            description: "Default `pull-request`.",
          }),
        ),
        message: Schema.optionalKey(Schema.String),
      },
      risk: "write",
      openWorld: true,
      permission: "github-issues:write",
      handler: async (input, auth) => {
        const args = input as {
          installationId: number;
          repo: string;
          path: string;
          content: string;
          sha: string | null;
          branch?: string;
          mode?: "pull-request" | "commit";
          message?: string;
        };
        try {
          return ok(
            await commitInfraenvFile(auth.organizationId, {
              ...args,
              mode: args.mode ?? "pull-request",
            }),
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
  ];
}

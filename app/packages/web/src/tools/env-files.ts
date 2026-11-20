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
import { GithubApiError } from "@infrawrench/server-core/github/issues-api";
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
  "and `[env.<name>]` (overrides). Each line is `KEY = value` where value is a literal, " +
  '`resource("<resourceId>", "<outputKey>")` (an output of a synced resource, read from the ' +
  'provider at pull time) or `secret("<NAME>")` (an organization secret; create one with ' +
  "write_workflow_secret). A quoted value is always a literal. Never write a secret value into " +
  "the file: reference it. A `# comment` line above a reference naming the resource keeps " +
  "reviews readable.";

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
      inputSchema: { source },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) =>
        ok(await describeInfraenv(auth.organizationId, (input as { source: string }).source)),
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
        const args = input as { source: string; environment?: string };
        try {
          return ok(
            await resolveInfraenv(auth.organizationId, {
              source: args.source,
              environment: args.environment ?? null,
            }),
          );
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

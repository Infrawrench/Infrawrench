/**
 * Environment files: `/api/org/:orgId/env-files`, the endpoint definitions.
 *
 * A project commits `.infraenv` (client-core `infraenv.ts`), which names each
 * variable's source: a literal, a resource output in the organization's
 * infrastructure, or an organization secret. These routes read and resolve
 * that file; they store nothing of their own. The file in the repository is
 * the source of truth, the values live where they always did (the provider,
 * or the organization's secrets), and `resolve` is the one route that returns
 * a secret value.
 *
 * Permissions: `describe` and `sources` read stored state (`resources:read`);
 * `resolve` hands out secret values (`secrets:read`, audited); reading and
 * committing the file in a repository go through the GitHub App installation
 * the organization connected (`github-issues:read` / `github-issues:write`,
 * the IaC pull request stance).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { INFRAENV_LIMITS } from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadGateway, BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";
import { GithubPermissionRequired } from "./github-issues";

const strictBody = { errors: "all", onExcessProperty: "error" } as const;

const InfraenvSourceText = Schema.String.check(maxLength(INFRAENV_LIMITS.maxSourceLength)).annotate(
  {
    description: "The `.infraenv` file's text.",
    examples: ['[env]\nDATABASE_URL = resource("neon:<account>:br-1", "connectionString")\n'],
  },
);

const EnvironmentName = Schema.String.check(
  maxLength(INFRAENV_LIMITS.maxEnvironmentNameLength),
).annotate({
  description: "An `[env.<name>]` section to lay over `[env]`. Omit for `[env]` alone.",
  examples: ["production"],
});

const InfraenvProblem = Schema.Struct({
  line: Schema.Int.annotate({ description: "1-based; 0 for the file as a whole." }),
  message: Schema.String,
  key: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "InfraenvProblem" });

export const InfraenvDescribeRequest = Schema.Struct({
  source: InfraenvSourceText,
}).annotate({ identifier: "InfraenvDescribeRequest" });

export const InfraenvResourceDescription = Schema.Struct({
  resourceId: Schema.String,
  output: Schema.String,
  found: Schema.Boolean.annotate({
    description: "False when the organization has no such resource (deleted, or a typo).",
  }),
  displayName: Schema.optionalKey(Schema.String),
  pluginId: Schema.optionalKey(Schema.String),
  pluginName: Schema.optionalKey(Schema.String),
  resourceTypeId: Schema.optionalKey(Schema.String),
  resourceTypeName: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
  accountName: Schema.optionalKey(Schema.String),
  outputLabel: Schema.optionalKey(Schema.String),
  outputKnown: Schema.Boolean.annotate({
    description: "False when the resource's type does not declare this output.",
  }),
  sensitive: Schema.Boolean,
}).annotate({ identifier: "InfraenvResourceDescription" });

export const InfraenvSecretDescription = Schema.Struct({
  name: Schema.String,
  found: Schema.Boolean,
  hasValue: Schema.Boolean,
}).annotate({ identifier: "InfraenvSecretDescription" });

export const InfraenvDescribeResponse = Schema.Struct({
  problems: Schema.Array(InfraenvProblem).annotate({
    description: "Syntax problems, then references that point at nothing.",
  }),
  environments: Schema.Array(Schema.String),
  resources: Schema.Array(InfraenvResourceDescription),
  secrets: Schema.Array(InfraenvSecretDescription),
}).annotate({ identifier: "InfraenvDescribeResponse" });

export const InfraenvResolveRequest = Schema.Struct({
  source: InfraenvSourceText,
  environment: Schema.optionalKey(Schema.NullOr(EnvironmentName)),
  sourceName: Schema.optionalKey(
    Schema.String.check(maxLength(512)).annotate({
      description:
        "The file's path, named in the generated `.env` header. Defaults to `.infraenv`.",
    }),
  ),
}).annotate({ identifier: "InfraenvResolveRequest" });

export const InfraenvResolveResponse = Schema.Struct({
  environment: Schema.NullOr(Schema.String),
  values: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
  problems: Schema.Array(InfraenvProblem).annotate({
    description:
      "Variables that did not resolve, with why. They are left out of `values` and `dotenv`.",
  }),
  dotenv: Schema.String.annotate({
    description: "The resolved `.env` text, starting with its auto-generated header.",
  }),
}).annotate({ identifier: "InfraenvResolveResponse" });

const InfraenvSourceOutput = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  sensitive: Schema.Boolean,
  suggestedKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "InfraenvSourceOutput" });

export const InfraenvSource = Schema.Struct({
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  outputs: Schema.Array(InfraenvSourceOutput),
}).annotate({ identifier: "InfraenvSource" });

export const InfraenvSourceList = Schema.Struct({
  sources: Schema.Array(InfraenvSource),
}).annotate({ identifier: "InfraenvSourceList" });

export const InfraenvRepo = Schema.Struct({
  installationId: Schema.Int,
  fullName: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
}).annotate({ identifier: "InfraenvRepo" });

export const InfraenvRepoList = Schema.Struct({
  appConfigured: Schema.Boolean,
  repos: Schema.Array(InfraenvRepo),
}).annotate({ identifier: "InfraenvRepoList" });

const RepoFullName = Schema.String.check(minLength(3), maxLength(201)).annotate({
  description: "`owner/name`.",
  examples: ["acme/web"],
});

const RepoPath = Schema.String.check(minLength(1), maxLength(1024)).annotate({
  description: "Path of the file in the repository. Defaults to `.infraenv` in the editors.",
  examples: [".infraenv", "apps/web/.infraenv"],
});

const BranchName = Schema.String.check(minLength(1), maxLength(255));

export const InfraenvRepoFile = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  content: Schema.NullOr(Schema.String).annotate({
    description: "Null when the file does not exist on that branch yet.",
  }),
  sha: Schema.NullOr(Schema.String).annotate({
    description: "Blob sha to send back with a commit that replaces the file.",
  }),
}).annotate({ identifier: "InfraenvRepoFile" });

export const InfraenvCommitRequest = Schema.Struct({
  installationId: Schema.Int,
  repo: RepoFullName,
  path: RepoPath,
  branch: Schema.optionalKey(
    Schema.NullOr(BranchName).annotate({
      description:
        "The branch to commit to, or to open the pull request against. Null means the default branch.",
    }),
  ),
  content: InfraenvSourceText,
  sha: Schema.NullOr(Schema.String).annotate({
    description:
      "The blob sha the file had when it was read, or null for a new file. A file changed since then answers 400 rather than being overwritten.",
  }),
  mode: Schema.Literals(["commit", "pull-request"]).annotate({
    description: "Commit straight to the branch, or to a new branch with a pull request.",
  }),
  message: Schema.optionalKey(Schema.String.check(maxLength(500))),
}).annotate({ identifier: "InfraenvCommitRequest" });

export const InfraenvCommitResult = Schema.Struct({
  mode: Schema.Literals(["commit", "pull-request"]),
  branch: Schema.String,
  commitSha: Schema.String,
  commitUrl: Schema.String,
  pullRequest: Schema.NullOr(Schema.Struct({ number: Schema.Int, url: Schema.String })),
}).annotate({ identifier: "InfraenvCommitResult" });

const GithubErrors = [BadRequest, NotFound, GithubPermissionRequired, BadGateway] as const;

export class EnvFilesGroup extends HttpApiGroup.make("envFiles")
  .add(
    HttpApiEndpoint.post("describe", "/describe", {
      params: OrgParams,
      payload: InfraenvDescribeRequest,
      success: InfraenvDescribeResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Check an .infraenv file")
      .annotate(
        OpenApi.Description,
        "Parses the file and looks up every reference it makes: which resource, account and output " +
          "each `resource()` names, and whether each `secret()` exists. Returns no values and calls " +
          "no provider.",
      )
      .annotate(SuccessDescription, "What the file references")
      .annotate(InvalidRequestMessage, "Invalid .infraenv request")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.post("resolve", "/resolve", {
      params: OrgParams,
      payload: InfraenvResolveRequest,
      success: InfraenvResolveResponse,
      error: [BadRequest],
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(OpenApi.Summary, "Resolve an .infraenv file into .env values")
      .annotate(
        OpenApi.Description,
        "Resolves every variable of one environment: literals as written, `resource()` through the " +
          "resource's provider, `secret()` from the organization's secrets. Returns the values in " +
          "plaintext along with the generated `.env` text, and records an audit entry naming the " +
          "variables (never their values). A variable that does not resolve is reported in " +
          "`problems` and left out. A file with syntax errors answers 400.",
      )
      .annotate(SuccessDescription, "Resolved values")
      .annotate(InvalidRequestMessage, "Invalid .infraenv request")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.get("sources", "/sources", {
      params: OrgParams,
      query: {
        q: Schema.optionalKey(
          Schema.String.check(maxLength(200)).annotate({
            description: "Matches the resource's name, id, type or account.",
          }),
        ),
        limit: Schema.optionalKey(
          Schema.FiniteFromString.annotate({ description: "1-100, default 50." }),
        ),
      },
      success: InfraenvSourceList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List resources an .infraenv variable can reference")
      .annotate(
        OpenApi.Description,
        "Synced resources whose type declares outputs, each with those outputs and, where the type " +
          "has a secret export template, the variable name it suggests. Backs the editor's picker.",
      )
      .annotate(SuccessDescription, "Resources with outputs"),
    HttpApiEndpoint.get("repos", "/repos", {
      params: OrgParams,
      success: InfraenvRepoList,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "List repositories an .infraenv can be read from and committed to")
      .annotate(
        OpenApi.Description,
        "Every repository the organization's GitHub App installations can reach.",
      )
      .annotate(SuccessDescription, "Repositories"),
    HttpApiEndpoint.get("readFile", "/repo-file", {
      params: OrgParams,
      query: {
        installationId: Schema.FiniteFromString.check(Schema.isInt()),
        repo: RepoFullName,
        path: RepoPath,
        branch: Schema.optionalKey(BranchName),
      },
      success: InfraenvRepoFile,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "Read an .infraenv file from a repository")
      .annotate(
        OpenApi.Description,
        "The file's text and blob sha on a branch (the default branch when omitted). A file that " +
          "does not exist yet answers 200 with `content: null`.",
      )
      .annotate(SuccessDescription, "The file"),
    HttpApiEndpoint.post("commit", "/commit", {
      params: OrgParams,
      payload: InfraenvCommitRequest,
      success: InfraenvCommitResult,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:write")
      .annotate(OpenApi.Summary, "Commit an .infraenv file to a repository")
      .annotate(
        OpenApi.Description,
        "Writes the file to the branch in one commit, or to a new branch with a pull request. The " +
          "text is checked first: a file with syntax errors is refused, so nothing unparseable is " +
          "committed. Values are never committed; the file only holds references.",
      )
      .annotate(SuccessDescription, "Committed")
      .annotate(InvalidRequestMessage, "Invalid .infraenv commit")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
  )
  .prefix("/api/org/:orgId/env-files")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Environment files") {}

export class EnvFilesApi extends withApiDefaults(HttpApi.make("envFiles").add(EnvFilesGroup)) {}

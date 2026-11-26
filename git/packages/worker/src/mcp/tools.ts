/**
 * The MCP server's tools: what an agent can do on the forge.
 *
 * Each is a thin wrapper over the forge's own JSON API (`api.ts`): it names
 * the request, makes it with the caller's credential and passes the answer
 * through, so what a tool may do is decided where everything else is
 * (`repoAccess`, the API's gates) and a tool works the day its endpoint does.
 * An endpoint this server does not serve yet answers 503 `not_implemented`,
 * which `expectOk` turns into a tool error that says so.
 *
 * The descriptions are written for the agent that reads them: when to call
 * the tool, what to put in it, and what happens next. They are the
 * instructions an agent gets for taking part in review, so a change of
 * behaviour changes them too.
 *
 * Names are `snake_case`. A tool that changes nothing says so
 * (`readOnlyHint`); none reaches outside the forge (`openWorldHint: false`).
 */
import { branchPagePath } from "@infrawrench/git-contract";
import type { Principal } from "../auth/principal";
import { type ApiCall, ToolFailure, expectOk } from "./api";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolContext {
  readonly api: ApiCall;
  readonly principal: Principal;
  /** The site's origin, for links. */
  readonly origin: string;
  /** What the MCP client calls itself, when it said. */
  readonly clientName: string | null;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /** Changes nothing on the forge. */
  readonly readOnly: boolean;
  /** Calling it again with the same input changes nothing more. */
  readonly idempotent: boolean;
  run(input: Readonly<Record<string, unknown>>, cx: ToolContext): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Inputs every branch tool shares
// ---------------------------------------------------------------------------

const REPOSITORY = {
  type: "string",
  minLength: 3,
  maxLength: 512,
  description:
    "The repository as `owner/name` (for example `acme/infra`). Its clone URL is accepted too.",
} as const;

const BRANCH = {
  type: "string",
  minLength: 1,
  maxLength: 600,
  description:
    "The branch: its short name (`feature/rate-limits`), or the `key` list_my_branches gave (`owner/name:feature/x` for a fork's branch proposed to this repository, `feature/x~2` for an earlier page of a reused name).",
} as const;

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

/** An output: the named properties are promised, and the API's other fields ride along. */
const output = (properties: Record<string, unknown>, required: readonly string[]): JsonSchema => ({
  type: "object",
  properties,
  required: [...required],
});

const ANY_OBJECT = { type: "object" } as const;
const LIST = { type: "array", items: ANY_OBJECT } as const;

const encode = (segment: string): string => encodeURIComponent(segment);

/** `/api/repos/<owner>/<name>` for `owner/name`, a clone URL or a page's address. */
export const repositoryPath = (value: unknown, origin: string): string => {
  if (typeof value !== "string") throw new ToolFailure("`repository` must be `owner/name`.");
  let text = value.trim();
  for (const prefix of [`${origin}/`, "https://git.infrawrench.com/", "git@git.infrawrench.com:"]) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }
  const [owner, name, ...rest] = text.replace(/^\/+/, "").split("/");
  const repo = (name ?? "").replace(/\.git$/, "");
  if (!owner || !repo || (rest.length > 0 && text.endsWith(".git"))) {
    throw new ToolFailure("`repository` must be `owner/name`, for example `acme/infra`.");
  }
  return `/api/repos/${encode(owner)}/${encode(repo)}`;
};

const shortBranch = (value: string): string =>
  value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;

/** A branch's page as a tool reads it: its API path, its key and the page itself. */
interface FoundPage {
  readonly path: string;
  readonly key: string;
  readonly page: Record<string, unknown>;
}

/**
 * The branch page a tool is about, read through `branches.get` (which opens
 * the page of a branch pushed before every branch had one). The bare name
 * is the branch's open page, or its newest, so a merged branch's page can
 * still be read.
 */
const pageOf = async (
  input: Readonly<Record<string, unknown>>,
  repo: string,
  cx: ToolContext,
): Promise<FoundPage> => {
  if (typeof input["branch"] !== "string" || input["branch"] === "") {
    throw new ToolFailure("Give `branch`.");
  }
  const branch = shortBranch(input["branch"]);
  const answer = await cx.api("GET", `${repo}/branches/${encode(branch)}`);
  if (answer.status === 404) {
    throw new ToolFailure(
      `The branch \`${branch}\` has no page: it does not exist, or has no commits of its own yet. Its page opens at its first push; push the branch, or call start_work to make the branch and its page from an ask.`,
    );
  }
  const page = record(expectOk(answer, "Reading the branch"));
  const key = typeof page["key"] === "string" ? page["key"] : branch;
  return { path: `${repo}/branches/${encode(key)}`, key, page };
};

const pick = (source: unknown, keys: readonly string[]): Record<string, unknown> => {
  const from = (typeof source === "object" && source !== null ? source : {}) as Record<
    string,
    unknown
  >;
  return Object.fromEntries(keys.filter((key) => key in from).map((key) => [key, from[key]]));
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The branch page's address, for a person to open. */
const pageUrl = (origin: string, repo: string, key: string): string => {
  const [owner = "", name = ""] = repo
    .replace(/^\/api\/repos\//, "")
    .split("/")
    .map((segment) => decodeURIComponent(segment));
  return `${origin}${branchPagePath(owner, name, key)}`;
};

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const whoami: ToolDefinition = {
  name: "whoami",
  title: "Who this connection acts as",
  description:
    "Says whose credential this connection uses and what it may do: a person (username, and the token's scopes when it is a token), an organisation's API key, or a CI job (one repository, one run). Call it once when you are unsure whether you can write: `can_write` false means recording traces, answering instructions and reporting findings will be refused.",
  inputSchema: object({}),
  outputSchema: output(
    {
      kind: { type: "string", enum: ["user", "api_key", "ci_job"] },
      username: { type: ["string", "null"] },
      user_id: { type: ["string", "null"] },
      scopes: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "A token's scopes. Null for a credential that has none.",
      },
      can_write: { type: "boolean" },
      repository_id: {
        type: ["string", "null"],
        description: "The one repository a CI job's token is for.",
      },
      ci_run_id: { type: ["string", "null"] },
    },
    ["kind", "can_write"],
  ),
  readOnly: true,
  idempotent: true,
  async run(_input, cx) {
    const principal = cx.principal;
    if (principal.kind === "job") {
      return {
        kind: "ci_job",
        username: null,
        user_id: null,
        scopes: null,
        // A job records traces on its run's branch; it writes nothing else through the API.
        can_write: true,
        repository_id: principal.repositoryId,
        ci_run_id: principal.runId,
      };
    }
    if (principal.kind === "api-key") {
      return {
        kind: "api_key",
        username: null,
        user_id: null,
        scopes: [...principal.permissions],
        can_write: principal.permissions.some((permission) =>
          /git:(write|admin)|\*/.test(permission),
        ),
        repository_id: null,
        ci_run_id: null,
      };
    }
    if (principal.kind !== "user") throw new ToolFailure("This connection has no identity.");
    const session = expectOk(await cx.api("GET", "/api/session"), "Reading your account") as {
      user?: { username?: string | null; displayName?: string | null } | null;
    };
    const scopes = principal.scopes === null ? null : [...principal.scopes];
    const username = session.user?.username ?? null;
    return {
      kind: "user",
      username,
      display_name: session.user?.displayName ?? null,
      user_id: principal.userId,
      scopes,
      // A person writes nothing until they have chosen a username.
      can_write: username !== null && (scopes === null || scopes.includes("repo:write")),
      repository_id: null,
      ci_run_id: null,
      ...(username === null
        ? { note: `This account has no username yet. Choose one at ${cx.origin} before writing.` }
        : {}),
    };
  },
};

const listMyBranches: ToolDefinition = {
  name: "list_my_branches",
  title: "Branches waiting on you",
  description:
    "Lists open branches that involve the person this connection acts as and have something they have not looked at: ones they wrote, are assigned, have reviewed, or connected an agent to, longest wait first. Each item names its repository and its `key`, which the other tools take as `branch`. Use it to find the branch you were working on, or to see what needs review.",
  inputSchema: object({
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 30." },
    cursor: { type: "string", description: "`nextCursor` of the previous page." },
  }),
  outputSchema: output({ items: LIST, nextCursor: { type: ["string", "null"] } }, ["items"]),
  readOnly: true,
  idempotent: true,
  async run(input, cx) {
    const page = expectOk(
      await cx.api("GET", "/api/review/inbox", {
        query: { limit: input["limit"] as number | undefined, cursor: input["cursor"] as string },
      }),
      "Reading the inbox",
    );
    return record(page);
  },
};

const getBranch: ToolDefinition = {
  name: "get_branch",
  title: "A branch's state",
  description:
    "Reads where a branch stands: its page (title, the branch it merges into, draft or not), its state (`agent_working`, `checks_failing`, `must_fix_open`, `needs_your_review`, `ready_to_merge`, `waiting`, `merged`, `closed`), its versions (one per push, oldest first), how many instructions are waiting for the agent (`openInstructions`), the findings tally, trace entries recorded since the last push, and the agent linked to it. Call it before you start on a branch someone else opened, and after a push to see what the reviewers and review agents made of it.",
  inputSchema: object({ repository: REPOSITORY, branch: BRANCH }, ["repository", "branch"]),
  outputSchema: output(
    {
      url: { type: "string", description: "The branch page, for a person to open." },
      key: { type: "string", description: "What the other tools take as `branch`." },
      page: ANY_OBJECT,
      state: ANY_OBJECT,
      versions: LIST,
      latestVersion: { type: ["integer", "null"] },
    },
    ["url", "key", "page", "state", "versions"],
  ),
  readOnly: true,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const [state, versions] = await Promise.all([
      cx.api("GET", `${found.path}/branch-state`),
      cx.api("GET", `${found.path}/versions`),
    ]);
    const listed = record(expectOk(versions, "Reading the branch's versions"));
    return {
      url: pageUrl(cx.origin, repo, found.key),
      key: found.key,
      page: pick(found.page, [
        "key",
        "title",
        "body",
        "state",
        "draft",
        "baseRef",
        "headRef",
        "headOid",
        "author",
        "status",
        "reviewDecision",
        "createdAt",
        "updatedAt",
      ]),
      state: record(expectOk(state, "Reading the branch's state")),
      versions: Array.isArray(listed["versions"]) ? listed["versions"] : [],
      latestVersion: listed["latest"] ?? null,
    };
  },
};

const getVersionDiff: ToolDefinition = {
  name: "get_version_diff",
  title: "A diff of a version",
  description:
    "Reads a diff of one version of a branch, paged by file. `mode` chooses what is compared: `whole` (the default) is the whole change at that version, base to tip; `step` is what that version changed since the one before it; `since` is everything since `since_version`. `step` and `since` compare each version against its own base, so a rebase alone shows nothing. Give `path` to read one file with all its hunks. Use `step` after a push to check what you actually changed, and `since` to see what happened after a version a reviewer commented on.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: BRANCH,
      version: {
        type: "integer",
        minimum: 1,
        description: "The version to read. The newest when omitted.",
      },
      mode: { type: "string", enum: ["whole", "step", "since"], description: "Default `whole`." },
      since_version: {
        type: "integer",
        minimum: 1,
        description: "For `mode: since`: the version to compare from.",
      },
      path: { type: "string", description: "Only this file." },
      context: {
        type: "integer",
        minimum: 0,
        maximum: 1000,
        description: "Lines of context. Default 3.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Files per page." },
      cursor: { type: "string", description: "`nextCursor` of the previous page." },
    },
    ["repository", "branch"],
  ),
  outputSchema: ANY_OBJECT,
  readOnly: true,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const mode = (input["mode"] as string | undefined) ?? "whole";
    if (mode === "since" && typeof input["since_version"] !== "number") {
      throw new ToolFailure("`mode: since` needs `since_version`.");
    }
    const from = mode === "step" ? "previous" : mode === "since" ? input["since_version"] : "base";
    const version = typeof input["version"] === "number" ? String(input["version"]) : "latest";
    const diff = expectOk(
      await cx.api("GET", `${found.path}/versions/${version}/diff`, {
        query: {
          from: from as string | number,
          path: input["path"] as string | undefined,
          context: input["context"] as number | undefined,
          limit: input["limit"] as number | undefined,
          cursor: input["cursor"] as string | undefined,
        },
      }),
      "Reading the diff",
    );
    return record(diff);
  },
};

const TRACE_ENTRY = object(
  {
    kind: {
      type: "string",
      enum: ["ask", "step", "decision", "evidence", "doubt", "note"],
      description:
        "`ask`: what you were asked to do, in the person's words. `step`: something you did. `decision`: a choice between alternatives, and why. `evidence`: something you ran or checked, with what it showed. `doubt`: something you are not sure of, or did not do. `note`: anything else a reviewer should know.",
    },
    body: {
      type: "string",
      minLength: 1,
      maxLength: 30000,
      description:
        "Markdown, a few sentences. Say what and why, not how you felt about it. Never put a secret here.",
    },
    anchors: {
      type: "array",
      maxItems: 64,
      description: "The files and lines the entry is about, so it shows beside them in the diff.",
      items: object(
        {
          path: { type: "string", minLength: 1, description: "A path in the repository." },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        ["path"],
      ),
    },
    evidence: object({
      command: { type: "string", maxLength: 8192, description: "What you ran, as you ran it." },
      exit_code: { type: "integer" },
      output: {
        type: "string",
        maxLength: 65536,
        description:
          "The part of the output that shows the result. An excerpt, not the log: long output is cut to its start and end.",
      },
      ci_run_id: { type: "string", description: "An Infrawrench CI run that is the evidence." },
      url: { type: "string", maxLength: 2048, description: "A link that is the evidence." },
    }),
  },
  ["kind", "body"],
);

const recordTrace: ToolDefinition = {
  name: "record_trace",
  title: "Record what you did",
  description: [
    "Records your work on a branch so the people who review it can see how it was made. This is the main thing to do with this server: call it as you work, not only at the end.",
    "",
    "When to call it:",
    "- At the start, one `ask` entry with what you were asked to do.",
    "- After each meaningful piece of work, a `step` entry (what you changed and why), with `anchors` to the files.",
    "- When you choose between alternatives, a `decision` entry naming what you chose, what you rejected and why.",
    "- Whenever you run tests, a build, a linter or any check, an `evidence` entry with the command, its exit code and the lines of output that show the result. Record failures too.",
    "- When you are unsure, skipped something, or could not verify something, a `doubt` entry. Reviewers read these first: an honest doubt is worth more than a confident summary.",
    "- Always just before `git push`, so nothing is left unrecorded.",
    "",
    "How it works: entries wait on the branch and are attached to the version the branch's next push makes, so record first and push after. Entries recorded after a push belong to the next one. The branch does not have to exist yet. Send several entries in one call, in the order they happened.",
    "",
    "Secrets (tokens, keys, passwords) are masked before anything is stored, but do not rely on it: leave them out. Needs write access to the repository.",
  ].join("\n"),
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: {
        ...BRANCH,
        description:
          "The branch you are working on, short (`feature/rate-limits`). Not the default branch.",
      },
      entries: { type: "array", minItems: 1, maxItems: 100, items: TRACE_ENTRY },
      agent_name: {
        type: "string",
        maxLength: 200,
        description:
          "What you are called (`Claude Code`, `Codex`). Your client's name when omitted.",
      },
      session: {
        type: "string",
        maxLength: 500,
        description:
          "Your own name or id for this session or thread, so entries from one session group together.",
      },
    },
    ["repository", "branch", "entries"],
  ),
  outputSchema: output(
    {
      recorded: { type: "integer" },
      branch: { type: "string" },
      entries: LIST,
      next: { type: "string" },
    },
    ["recorded", "entries"],
  ),
  readOnly: false,
  idempotent: false,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const entries = (Array.isArray(input["entries"]) ? input["entries"] : []).map((raw) => {
      const entry = record(raw);
      const evidence = entry["evidence"] === undefined ? undefined : record(entry["evidence"]);
      return {
        kind: entry["kind"],
        body: entry["body"],
        ...(Array.isArray(entry["anchors"])
          ? {
              anchors: entry["anchors"].map((anchor) => {
                const { path, start_line, end_line } = record(anchor);
                return {
                  path,
                  ...(start_line === undefined ? {} : { startLine: start_line }),
                  ...(end_line === undefined ? {} : { endLine: end_line }),
                };
              }),
            }
          : {}),
        ...(evidence === undefined
          ? {}
          : {
              evidence: {
                ...(evidence["command"] === undefined ? {} : { command: evidence["command"] }),
                ...(evidence["exit_code"] === undefined ? {} : { exitCode: evidence["exit_code"] }),
                ...(evidence["output"] === undefined ? {} : { output: evidence["output"] }),
                ...(evidence["ci_run_id"] === undefined ? {} : { ciRunId: evidence["ci_run_id"] }),
                ...(evidence["url"] === undefined ? {} : { url: evidence["url"] }),
              },
            }),
      };
    });
    const name =
      typeof input["agent_name"] === "string" && input["agent_name"] !== ""
        ? input["agent_name"]
        : (cx.clientName ?? "MCP client");
    const stored = record(
      expectOk(
        await cx.api("POST", `${repo}/traces`, {
          body: {
            branch: shortBranch(String(input["branch"] ?? "")),
            agent: {
              kind: "mcp",
              name: name.slice(0, 200),
              ...(typeof input["session"] === "string" ? { sessionRef: input["session"] } : {}),
            },
            entries,
          },
        }),
        "Recording the trace",
      ),
    );
    const kept = Array.isArray(stored["entries"]) ? stored["entries"] : [];
    return {
      recorded: kept.length,
      branch: shortBranch(String(input["branch"] ?? "")),
      entries: kept,
      next: "These entries wait on the branch. They are attached to the version your next push to it makes.",
    };
  },
};

const INSTRUCTION_ID = {
  type: "string",
  minLength: 1,
  description: "The instruction's `id`, from list_instructions.",
} as const;

const listInstructions: ToolDefinition = {
  name: "list_instructions",
  title: "What reviewers sent back to you",
  description:
    "Lists the instructions on a branch: review comments, findings and notes that a reviewer sent to the agent that writes the branch. Call it when you pick a branch up, and after each push, to see what you have been asked to change. By default it lists what is still to do (`queued` and `delivered`). For each one you take on, call mark_instruction_delivered so the reviewer sees you have it, do the work, record it with record_trace, and call mark_instruction_answered before you push.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: BRANCH,
      status: {
        type: "string",
        enum: ["open", "queued", "delivered", "answered", "dismissed", "all"],
        description: "Default `open`: queued and delivered.",
      },
    },
    ["repository", "branch"],
  ),
  outputSchema: output({ branch: { type: "string" }, instructions: LIST }, ["instructions"]),
  readOnly: true,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const status = (input["status"] as string | undefined) ?? "open";
    const listed = record(
      expectOk(
        await cx.api("GET", `${found.path}/instructions`, {
          query: { status: status === "open" || status === "all" ? undefined : status },
        }),
        "Reading the instructions",
      ),
    );
    const all = Array.isArray(listed["instructions"]) ? listed["instructions"] : [];
    return {
      branch: found.key,
      instructions:
        status === "open"
          ? all.filter((item) => ["queued", "delivered"].includes(String(record(item)["status"])))
          : all,
    };
  },
};

const markInstructionDelivered: ToolDefinition = {
  name: "mark_instruction_delivered",
  title: "Say you have an instruction",
  description:
    "Marks an instruction as delivered: it has reached you and you are going to act on it. Call it once for each instruction from list_instructions that you take on, before you start the work. The reviewer then sees the branch as `agent_working` instead of waiting.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: BRANCH,
      instruction_id: INSTRUCTION_ID,
    },
    ["repository", "branch", "instruction_id"],
  ),
  outputSchema: output({ instruction: ANY_OBJECT }, ["instruction"]),
  readOnly: false,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const id = encode(String(input["instruction_id"]));
    return {
      instruction: record(
        expectOk(
          await cx.api("PUT", `${found.path}/instructions/${id}/delivered`, {
            body: { via: "mcp" },
          }),
          "Marking the instruction delivered",
        ),
      ),
    };
  },
};

const markInstructionAnswered: ToolDefinition = {
  name: "mark_instruction_answered",
  title: "Say which push answers an instruction",
  description:
    "Marks an instruction as answered by a version of the branch. Call it when the work an instruction asked for is done and committed, just before you push: leave `version` out and it is tied to the version your next push makes. Give `version` only when a version already pushed is the answer. If you decided not to do what was asked, still record why with record_trace (a `decision` or `doubt` entry) and then mark it answered, so the reviewer reads the reason beside the version.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: BRANCH,
      instruction_id: INSTRUCTION_ID,
      version: {
        type: "integer",
        minimum: 1,
        description: "The version that answers it. Omitted: the next version pushed.",
      },
    },
    ["repository", "branch", "instruction_id"],
  ),
  outputSchema: output({ instruction: ANY_OBJECT }, ["instruction"]),
  readOnly: false,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const id = encode(String(input["instruction_id"]));
    return {
      instruction: record(
        expectOk(
          await cx.api("PUT", `${found.path}/instructions/${id}/answered`, {
            body: typeof input["version"] === "number" ? { version: input["version"] } : {},
          }),
          "Marking the instruction answered",
        ),
      ),
    };
  },
};

const listFindings: ToolDefinition = {
  name: "list_findings",
  title: "What review agents found",
  description:
    "Lists what review agents found on a branch, in file then line order, with a tally. Each finding has a severity (`must_fix` holds the merge until it is fixed, dismissed or overridden; `should_fix`; `note`), a title and body, the file and lines, and its evidence. Call it after a push to see what to fix: fix `must_fix` findings, or say why not in a `doubt` or `decision` trace entry. A finding is marked fixed by the reviewer's next run, not by you.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: BRANCH,
      status: {
        type: "string",
        enum: ["open", "fixed", "dismissed"],
        description: "All when omitted.",
      },
      version: { type: "integer", minimum: 1, description: "Only findings seen on this version." },
    },
    ["repository", "branch"],
  ),
  outputSchema: output({ branch: { type: "string" }, findings: LIST, tally: ANY_OBJECT }, [
    "findings",
  ]),
  readOnly: true,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const listed = record(
      expectOk(
        await cx.api("GET", `${found.path}/findings`, {
          query: {
            status: input["status"] as string | undefined,
            version: input["version"] as number | undefined,
          },
        }),
        "Reading the findings",
      ),
    );
    return {
      branch: found.key,
      findings: Array.isArray(listed["findings"]) ? listed["findings"] : [],
      tally: record(listed["tally"]),
    };
  },
};

const reportFinding: ToolDefinition = {
  name: "report_finding",
  title: "Report review findings",
  description:
    "Reports what you found reviewing a version of a branch. For an agent that reviews work, not the one that wrote it. Read the change first (get_branch, get_version_diff), then report one finding per problem: a `severity` (`must_fix` only for what must not merge: a bug, a security problem, something the ask said to do and the change does not; `should_fix` for what ought to change; `note` for the rest), a short `title`, a `body` saying what is wrong and what would fix it, the `path` and lines, and `evidence` (the code, a command you ran and its output, a failing test). Set `complete: true` when this is everything you find on the version: your earlier findings that are not in the list are then marked fixed. A finding with the same `fingerprint` as one already known updates it, and one a person dismissed stays dismissed. Needs write access.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      branch: BRANCH,
      reviewer: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description:
          "What kind of reviewer you are: `general`, `security`, `tests`, `terraform`, `intent`, or your own name for it. Findings are grouped by it.",
      },
      version: {
        type: "integer",
        minimum: 1,
        description: "The version you reviewed. The newest when omitted.",
      },
      complete: {
        type: "boolean",
        description: "This list is everything this reviewer finds on the version.",
      },
      findings: {
        type: "array",
        maxItems: 200,
        items: object(
          {
            severity: { type: "string", enum: ["must_fix", "should_fix", "note"] },
            title: { type: "string", minLength: 1, maxLength: 256 },
            body: {
              type: "string",
              description: "Markdown: what is wrong, and what would fix it.",
            },
            path: {
              type: "string",
              description: "Omit for a finding about the change as a whole.",
            },
            side: {
              type: "string",
              enum: ["LEFT", "RIGHT"],
              description:
                "`RIGHT` (default): lines of the new file. `LEFT`: lines the change removed.",
            },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            evidence: {
              type: "array",
              maxItems: 32,
              items: object(
                {
                  kind: {
                    type: "string",
                    description: "`code`, `command`, `test`, `ci` or `reference`.",
                  },
                  text: { type: "string", maxLength: 65536 },
                  url: { type: "string", maxLength: 2048 },
                },
                ["kind", "text"],
              ),
            },
            fingerprint: {
              type: "string",
              maxLength: 200,
              description:
                "Stable for the same finding across versions. Derived from the reviewer, path and title when omitted.",
            },
          },
          ["severity", "title"],
        ),
      },
    },
    ["repository", "branch", "reviewer", "findings"],
  ),
  outputSchema: output({ branch: { type: "string" }, findings: LIST }, ["findings"]),
  readOnly: false,
  idempotent: true,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const found = await pageOf(input, repo, cx);
    const findings = (Array.isArray(input["findings"]) ? input["findings"] : []).map((raw) => {
      const { start_line, end_line, ...rest } = record(raw);
      return {
        ...rest,
        ...(start_line === undefined ? {} : { startLine: start_line }),
        ...(end_line === undefined ? {} : { endLine: end_line }),
      };
    });
    const stored = record(
      expectOk(
        await cx.api("POST", `${found.path}/findings`, {
          body: {
            reviewerKind: input["reviewer"],
            ...(typeof input["version"] === "number" ? { version: input["version"] } : {}),
            ...(typeof input["complete"] === "boolean" ? { complete: input["complete"] } : {}),
            findings,
          },
        }),
        "Reporting the findings",
      ),
    );
    return {
      branch: found.key,
      findings: Array.isArray(stored["findings"]) ? stored["findings"] : [],
    };
  },
};

const startWork: ToolDefinition = {
  name: "start_work",
  title: "Start work from an ask",
  description:
    "Creates a new branch and its page (a draft whose description is the ask) before any code exists, so the person who asked can watch the work from the first push. Call it when you are given a task in a repository and no branch exists for it yet. Then fetch, check the branch out (`git fetch origin && git switch <branch>`), record the ask with record_trace, work, and push. If the branch already exists, skip this: the page is opened at its first push. Needs a person's credential with write access; a CI job cannot start work.",
  inputSchema: object(
    {
      repository: REPOSITORY,
      ask: {
        type: "string",
        minLength: 1,
        description:
          "What is being asked for, in the person's words. Markdown. It becomes the page's description.",
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "The ask's first line when omitted.",
      },
      branch: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        description: "The new branch's name. Made from the title when omitted.",
      },
      base: {
        type: "string",
        description: "The branch to start from. The default branch when omitted.",
      },
      agent_name: {
        type: "string",
        maxLength: 200,
        description: "What you are called. Your client's name when omitted.",
      },
      session: {
        type: "string",
        maxLength: 500,
        description: "Your own id for this session or thread.",
      },
    },
    ["repository", "ask"],
  ),
  outputSchema: output(
    {
      branch: { type: "string" },
      key: {
        type: "string",
        description: "The page's key: what the other tools take as `branch`.",
      },
      url: { type: "string", description: "The branch page, for a person to open." },
      page: ANY_OBJECT,
      next: { type: "string" },
    },
    ["branch", "key", "url"],
  ),
  readOnly: false,
  idempotent: false,
  async run(input, cx) {
    const repo = repositoryPath(input["repository"], cx.origin);
    const name =
      typeof input["agent_name"] === "string" && input["agent_name"] !== ""
        ? input["agent_name"]
        : (cx.clientName ?? "MCP client");
    const started = record(
      expectOk(
        await cx.api("POST", `${repo}/work`, {
          body: {
            ask: input["ask"],
            ...(typeof input["title"] === "string" ? { title: input["title"] } : {}),
            ...(typeof input["branch"] === "string" ? { branch: input["branch"] } : {}),
            ...(typeof input["base"] === "string" ? { base: input["base"] } : {}),
            agent: {
              kind: "mcp",
              displayName: name.slice(0, 200),
              ...(typeof input["session"] === "string"
                ? { externalRefs: { session: input["session"] } }
                : {}),
            },
          },
        }),
        "Starting work",
      ),
    );
    const page = record(started["page"]);
    const branch = String(started["branch"] ?? "");
    const key = typeof page["key"] === "string" ? page["key"] : branch;
    return {
      branch,
      key,
      url: pageUrl(cx.origin, repo, key),
      page: pick(page, ["key", "title", "state", "draft", "baseRef", "headRef", "createdAt"]),
      agent: started["agent"] ?? null,
      next: `Run \`git fetch origin && git switch ${branch}\`, record the ask with record_trace, then work and push.`,
    };
  },
};

/** Every tool, in the order `tools/list` gives them. */
export const TOOLS: readonly ToolDefinition[] = [
  whoami,
  listMyBranches,
  getBranch,
  getVersionDiff,
  recordTrace,
  listInstructions,
  markInstructionDelivered,
  markInstructionAnswered,
  listFindings,
  reportFinding,
  startWork,
];

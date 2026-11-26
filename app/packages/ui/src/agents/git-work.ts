/**
 * An agent session that works on a pull request on git.infrawrench.com
 * ("Start work with Infrawrench"): the first prompt the coding tool starts
 * with, and the shell commands that hand the VM its forge credential and that
 * prompt. Pure: imported by the web API server (through the
 * `agents/launch-command` entry) and by tests.
 *
 * The credential is a job token bound to the pull request's head branch
 * (client-core's `git-job-token.ts`, the `ref` claim): it clones the
 * repository, pushes that one branch, and calls the forge's trace and
 * instruction endpoints for it. It lasts at most six hours
 * (`GIT_JOB_TOKEN_MAX_TTL_SECONDS`). After that pushes and API calls answer
 * 401 until the session is opened again in Infrawrench, which writes a fresh
 * one to the same file.
 *
 * Every secret reaches the VM on an SSH channel's stdin, never in a command
 * line, so nothing that logs commands or their output sees it.
 */
/** POSIX single-quote `value` as one shell word (launch-command.ts has the same; it imports this module). */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Under the remote `$HOME`: where the session's forge token is kept (0600). */
export const GIT_WORK_TOKEN_FILE = ".infrawrench-agent/git-token";
/** Under the remote `$HOME`: the git credential helper that answers with that token. */
export const GIT_WORK_CREDENTIAL_HELPER = ".infrawrench-agent/git-credential";
/**
 * Under the remote `$HOME`: the prompt the tool starts with. The launch
 * command renames it to {@link GIT_WORK_PROMPT_SENT_FILE} as it starts the
 * tool, so a restart or a reattach never sends it twice.
 */
export const GIT_WORK_PROMPT_FILE = ".infrawrench-agent/first-prompt.md";
export const GIT_WORK_PROMPT_SENT_FILE = ".infrawrench-agent/first-prompt.sent.md";
/** The environment variable the tool's process gets the token in. */
export const GIT_WORK_TOKEN_ENV = "INFRAWRENCH_GIT_TOKEN";
/** How the session names itself to the forge's trace and instruction endpoints. */
export const GIT_WORK_AGENT_KIND = "infrawrench";

export interface GitWorkPromptInput {
  /** The namespace's and the repository's names on the forge. */
  readonly owner: string;
  readonly repo: string;
  readonly pull: number;
  /** The head branch, short. */
  readonly branch: string;
  /** The pull request's title and body: the ask, as the person wrote it. */
  readonly title: string;
  readonly body: string;
  /** The pull request's page. */
  readonly pullUrl: string;
  /** The forge's origin, without a trailing slash. */
  readonly forgeOrigin: string;
  /** The agent session's id, recorded on trace entries. */
  readonly sessionId: string;
}

/**
 * The prompt a session started from a pull request begins with: the ask,
 * where to push, and how to keep reviewers informed through the forge's API.
 * The ask is the person's markdown and is passed to the tool as one argument
 * read from a file, so nothing in it is ever interpreted by a shell.
 */
export function buildGitWorkPrompt(input: GitWorkPromptInput): string {
  const origin = input.forgeOrigin.replace(/\/+$/, "");
  const api = `${origin}/api/repos/${input.owner}/${input.repo}`;
  const instructions = `${api}/pulls/${input.pull}/instructions`;
  const auth = `-H "Authorization: Bearer $${GIT_WORK_TOKEN_ENV}"`;
  const json = `-H 'Content-Type: application/json'`;
  const agent = JSON.stringify({
    kind: GIT_WORK_AGENT_KIND,
    name: "Infrawrench agent",
    sessionRef: input.sessionId,
  });
  const traceBody = `{"branch":${JSON.stringify(input.branch)},"agent":${agent},"entries":[{"kind":"step","body":"What you did and why"}]}`;
  const ask = input.body.trim();
  return [
    `You are working on pull request #${input.pull} in ${input.owner}/${input.repo} on the Infrawrench Git forge: ${input.pullUrl}`,
    "",
    "## The ask",
    "",
    `### ${input.title.trim() || "(untitled)"}`,
    "",
    ask || "(The pull request has no description: the title is the ask.)",
    "",
    "## Where the work goes",
    "",
    `- The repository is checked out in the current directory, on the branch \`${input.branch}\`.`,
    `- Commit your work and push it to \`${input.branch}\` on origin: \`git push origin ${input.branch}\`. Every push becomes a version that reviewers read at ${input.pullUrl}. Push early and often.`,
    `- Your credential pushes this branch only. Pushing another branch or a tag, or deleting this branch, is refused.`,
    "",
    "## Keeping reviewers informed",
    "",
    `Every call below authenticates with the token in \`$${GIT_WORK_TOKEN_ENV}\`. It lasts at most 6 hours. When a push or a call answers 401, it has expired: ask the person to open this session again in Infrawrench, which writes a fresh token to \`~/${GIT_WORK_TOKEN_FILE}\`, then run \`export ${GIT_WORK_TOKEN_ENV}="$(cat ~/${GIT_WORK_TOKEN_FILE})"\`. Git reads the file by itself.`,
    "",
    "1. Record what you do as you go (a trace), so a reviewer can follow your reasoning. Entry kinds: `ask`, `step`, `decision`, `evidence` (a command you ran and what it showed), `doubt`, `note`. Entries recorded before a push belong to that push's version.",
    "",
    "```sh",
    `curl -fsS -X POST ${auth} ${json} '${api}/traces' --data '${traceBody}'`,
    "```",
    "",
    "2. Reviewers send instructions. Read the queued ones before you start, and again after every push:",
    "",
    "```sh",
    `curl -fsS ${auth} '${instructions}?status=queued'`,
    "```",
    "",
    "3. When you read an instruction, mark it delivered:",
    "",
    "```sh",
    `curl -fsS -X PUT ${auth} ${json} '${instructions}/<id>/delivered' --data '{"via":"${GIT_WORK_AGENT_KIND}"}'`,
    "```",
    "",
    "4. Once you have made the change an instruction asks for, mark it answered before you push: the next version you push is the one that answers it.",
    "",
    "```sh",
    `curl -fsS -X PUT ${auth} ${json} '${instructions}/<id>/answered' --data '{}'`,
    "```",
    "",
    "Then push.",
  ].join("\n");
}

/**
 * Writes the session's forge token (read from stdin) to
 * {@link GIT_WORK_TOKEN_FILE}, the credential helper that answers git with
 * it, and the `~/.gitconfig` entry scoped to the forge's origin that names
 * that helper. Nothing secret is in the command or in any config file: the
 * helper reads the token file each time, so writing a fresh token is all a
 * renewal takes. Idempotent. Works before git is installed (the bootstrap
 * installs it), since it writes the config itself.
 */
export function buildGitWorkCredentialCommand(forgeOrigin: string): string {
  const origin = forgeOrigin.replace(/\/+$/, "");
  const section = `[credential "${origin}"]`;
  const script = `
set -eu
umask 077
DIR="$HOME/.infrawrench-agent"
mkdir -p "$DIR"
chmod 700 "$DIR"
cat > "$HOME/${GIT_WORK_TOKEN_FILE}.tmp"
chmod 600 "$HOME/${GIT_WORK_TOKEN_FILE}.tmp"
mv -f "$HOME/${GIT_WORK_TOKEN_FILE}.tmp" "$HOME/${GIT_WORK_TOKEN_FILE}"
HELPER="$HOME/${GIT_WORK_CREDENTIAL_HELPER}"
cat > "$HELPER.tmp" <<'IWHELPER'
#!/bin/sh
# Written by Infrawrench: answers git with this session's forge token.
[ "$1" = get ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$(cat "$HOME/${GIT_WORK_TOKEN_FILE}")"
IWHELPER
chmod 700 "$HELPER.tmp"
mv -f "$HELPER.tmp" "$HELPER"
SECTION=${shellQuote(section)}
touch "$HOME/.gitconfig"
if ! grep -qxF "$SECTION" "$HOME/.gitconfig"; then
  # The empty helper first drops any helper configured before this one, so
  # nothing stores the token anywhere else.
  printf '\\n%s\\n\\thelper =\\n\\thelper = %s\\n' "$SECTION" "$HELPER" >> "$HOME/.gitconfig"
fi
if ! grep -qx '\\[user\\]' "$HOME/.gitconfig"; then
  printf '[user]\\n\\tname = Infrawrench agent\\n\\temail = agent@users.noreply.infrawrench.com\\n' >> "$HOME/.gitconfig"
fi
`;
  return `bash -c ${shellQuote(script)}`;
}

/**
 * Writes the first prompt (read from stdin) to {@link GIT_WORK_PROMPT_FILE},
 * unless the tool has already started with it once.
 */
export function buildGitWorkPromptWriteCommand(): string {
  const script = `
set -eu
mkdir -p "$HOME/.infrawrench-agent"
if [ -f "$HOME/${GIT_WORK_PROMPT_SENT_FILE}" ]; then
  cat > /dev/null
  exit 0
fi
cat > "$HOME/${GIT_WORK_PROMPT_FILE}.tmp"
mv -f "$HOME/${GIT_WORK_PROMPT_FILE}.tmp" "$HOME/${GIT_WORK_PROMPT_FILE}"
`;
  return `bash -c ${shellQuote(script)}`;
}

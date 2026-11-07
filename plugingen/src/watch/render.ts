import type { CheckReport } from "../check.js";
import { codeSpan, fenced, oneLine } from "../text.js";

export type TypecheckResult =
  { state: "passed" } | { state: "failed"; output: string } | { state: "not-run"; reason: string };

const BRANCH_PREFIX = "plugingen/";
const ISSUE_TITLE_SUFFIX = "could not be checked against its vendor document";
const ISSUE_TITLE = new RegExp(`^plugingen: ([a-z0-9][a-z0-9-]*) ${ISSUE_TITLE_SUFFIX}$`);
const MAX_LISTED = 200;

export function branchFor(plugin: string): string {
  return `${BRANCH_PREFIX}${plugin}`;
}

export function pluginOfBranch(branch: string): string | undefined {
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : undefined;
}

export function issueTitle(plugin: string): string {
  return `plugingen: ${plugin} ${ISSUE_TITLE_SUFFIX}`;
}

export function pluginOfIssueTitle(title: string): string | undefined {
  return ISSUE_TITLE.exec(title)?.[1];
}

export const ISSUE_SEARCH = `"${ISSUE_TITLE_SUFFIX}" in:title`;

export function pullRequestTitle(plugin: string): string {
  return `chore(${plugin}): update generated API types`;
}

export const COMMIT_MESSAGE = (plugin: string): string =>
  `chore(${plugin}): update generated API types\n\nThe vendor document changed something this plugin uses. Written by plugingen watch.`;

function listOperations(operations: readonly string[]): string {
  if (operations.length === 0) {
    return "None: only the file header differs, or the file had not been generated yet.";
  }
  const shown = operations.slice(0, MAX_LISTED).map((operation) => `- ${codeSpan(operation)}`);
  if (operations.length > MAX_LISTED) shown.push(`- and ${operations.length - MAX_LISTED} more`);
  return shown.join("\n");
}

function renderTypecheck(plugin: string, typecheck: TypecheckResult): string {
  switch (typecheck.state) {
    case "passed":
      return `The plugin compiles against these types.`;
    case "failed":
      return `**The plugin does not compile against these types.** This is the case this pull request exists for: the vendor changed something ${codeSpan(plugin)} depends on, so the plugin needs a fix on this branch before it can merge.\n\n${fenced(typecheck.output)}`;
    case "not-run":
      return `The typecheck did not run: ${oneLine(typecheck.reason)}`;
  }
}

/** The body is data: vendor-derived text only appears inside code spans and fences. */
export function renderPullRequestBody(report: CheckReport, typecheck: TypecheckResult): string {
  return `The generated API types for ${codeSpan(report.plugin)} no longer match the vendor's document. They only cover the operations this plugin lists, so this is something the plugin actually uses.

## Vendor documents

${report.specUrls.map((url) => `- ${url}`).join("\n")}

## Operations affected

${listOperations(report.operations ?? [])}

## Typecheck

${renderTypecheck(report.plugin, typecheck)}

---

Opened by \`plugingen watch\`, which keeps one pull request per plugin. It rewrites this description and, when the vendor's output moves again, force-pushes this branch, dropping any commits on it. It closes the pull request if the output matches \`main\` again. Closing it by hand only lasts until the next run, since the difference is still there; to accept the vendor's change, merge it.`;
}

export function renderIssueBody(report: CheckReport): string {
  const documents =
    report.specUrls.length > 0
      ? report.specUrls.map((url) => `- ${url}`).join("\n")
      : "None: the plugin's config could not be read.";
  return `\`plugingen check\` cannot regenerate the API types for ${codeSpan(report.plugin)}, so changes to what it uses from the vendor are going unnoticed.

## Failure

Kind: ${codeSpan(report.failure ?? "unknown")}

${fenced(report.reason)}

## Vendor documents

${documents}

## What to do

An operation that has gone means the plugin is calling something the vendor removed: fix the plugin and take it out of \`plugingen.json\`. A patch that no longer applies usually means the vendor fixed their document, so remove the patch. A document that moved needs a new \`specUrl\`.

Reproduce with \`pnpm plugingen check ${report.plugin}\`.

---

Opened by \`plugingen watch\`, which closes it once the check passes again. A plain network failure never opens one.`;
}

export const CLOSE_PULL_REQUEST_COMMENT =
  "The regenerated types match `main` again, so there is nothing left to review. Closed by `plugingen watch`.";

export const CLOSE_ISSUE_COMMENT = "The check passes again. Closed by `plugingen watch`.";

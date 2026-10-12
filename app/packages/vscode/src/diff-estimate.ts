import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CloudApiError, formatMonthlyDelta, previewPrCheckFiles } from "@infrawrench/client-core";
import { readConfig } from "./config";
import { collectWorkingTreeDiff, type GitRunner } from "./git-diff";
import { githubRepoFromRemote } from "./org-input";
import type { Session } from "./session";

function gitRunner(cwd: string): GitRunner {
  return {
    run: (args) =>
      new Promise((resolve, reject) => {
        execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        );
      }),
    readFile: (p) => readFile(path.join(cwd, p), "utf8").catch(() => null),
  };
}

async function repositoryRoot(): Promise<string | null> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder =
    (active && vscode.workspace.getWorkspaceFolder(active)) ??
    vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  const cwd = active?.scheme === "file" ? path.dirname(active.fsPath) : folder.uri.fsPath;
  try {
    return (await gitRunner(cwd).run(["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

/**
 * "What will this cost?" for uncommitted infrastructure changes: the working
 * tree (unsaved editors included) against `HEAD`, through the same
 * `POST /pr-checks/preview` a pull request check uses, so the numbers match
 * the check the pull request will get.
 */
export async function estimateWorkingTree(session: Session): Promise<void> {
  const api = session.api;
  const orgId = session.orgId;
  if (!api || !orgId) {
    await vscode.commands.executeCommand("infrawrench.signIn");
    return;
  }
  const root = await repositoryRoot();
  if (!root) {
    void vscode.window.showWarningMessage(
      "Infrawrench: open a file inside a git repository first.",
    );
    return;
  }
  const git = gitRunner(root);
  const overrides = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty || doc.uri.scheme !== "file") continue;
    const rel = path.relative(root, doc.uri.fsPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel))
      overrides.set(rel.split(path.sep).join("/"), doc.getText());
  }

  const repo =
    readConfig().costEstimateRepository ||
    githubRepoFromRemote(await git.run(["remote", "get-url", "origin"]).catch(() => "")) ||
    undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Infrawrench: estimating the change" },
    async () => {
      const diff = await collectWorkingTreeDiff(git, overrides);
      if (diff.files.length === 0) {
        void vscode.window.showInformationMessage(
          "Infrawrench: no Terraform, Infrafile or Kubernetes changes against HEAD.",
        );
        return;
      }
      let preview;
      try {
        preview = await previewPrCheckFiles(api, orgId, diff.files, repo);
      } catch (err) {
        const status = err instanceof CloudApiError ? err.status : 0;
        void vscode.window.showErrorMessage(
          status === 403
            ? "Infrawrench: estimating needs the iac:read permission."
            : `Infrawrench: the estimate failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (!preview) return;
      const header = [
        `# ${preview.title}`,
        "",
        `_Working tree of \`${path.basename(root)}\` against HEAD${repo ? `, with ${repo}'s check settings` : ""}._`,
        "",
      ];
      if (diff.skipped.length > 0) {
        header.push(
          `Left out: ${diff.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}.`,
          "",
        );
      }
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `${header.join("\n")}\n${preview.markdown}\n`,
      });
      await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
      const { monthlyDelta, currency } = preview.report.totals;
      if (monthlyDelta !== null && currency) {
        vscode.window.setStatusBarMessage(
          `Infrawrench: ${formatMonthlyDelta(monthlyDelta, currency)}/month`,
          15_000,
        );
      }
    },
  );
}

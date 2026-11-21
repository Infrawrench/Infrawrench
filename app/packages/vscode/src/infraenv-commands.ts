import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  INFRAENV_FILE_NAME,
  fetchInfraenvResolve,
  fetchInfraenvSources,
  infraenvEnvironmentNames,
  infraenvKeyForOutput,
  infraenvKeysIn,
  infraenvOutputPath,
  infraenvPullDecision,
  infraenvReferenceLines,
  infraenvSectionAt,
  isInfraenvKey,
  parseInfraenv,
  uniqueInfraenvKey,
  type InfraenvProblem,
  type InfraenvSource,
  type InfraenvSourceOutput,
} from "@infrawrench/client-core";
import { isInfraenvDocument, type InfraenvChecker } from "./infraenv";
import type { Session } from "./session";

let output: vscode.OutputChannel | null = null;
function outputChannel(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("Infrawrench");
  return output;
}

export function disposeInfraenvOutput(): void {
  output?.dispose();
  output = null;
}

async function requireSession(session: Session): Promise<boolean> {
  if (session.api && session.orgId) return true;
  await vscode.commands.executeCommand("infrawrench.signIn");
  return Boolean(session.api && session.orgId);
}

/**
 * The `.infraenv` a command acts on: the active editor's, else the only one
 * in the workspace, else one the user picks. Opened as a document so an
 * unsaved buffer is what gets checked or pulled.
 */
async function pickInfraenvDocument(): Promise<vscode.TextDocument | null> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && isInfraenvDocument(active)) return active;
  const found = await vscode.workspace.findFiles(
    `**/{${INFRAENV_FILE_NAME},*.infraenv}`,
    "**/node_modules/**",
    50,
  );
  if (found.length === 0) {
    void vscode.window.showWarningMessage(`No ${INFRAENV_FILE_NAME} file in this workspace.`);
    return null;
  }
  const uri =
    found.length === 1
      ? found[0]!
      : (
          await vscode.window.showQuickPick(
            found
              .map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u }))
              .sort((a, b) => a.label.localeCompare(b.label)),
            { title: `Which ${INFRAENV_FILE_NAME}?` },
          )
        )?.uri;
  return uri ? vscode.workspace.openTextDocument(uri) : null;
}

/** Infrawrench: Check .infraenv. Describes the file now and shows the Problems view. */
export async function checkInfraenvCommand(
  session: Session,
  checker: InfraenvChecker,
): Promise<void> {
  const doc = await pickInfraenvDocument();
  if (!doc) return;
  if (!(await requireSession(session))) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Checking .infraenv" },
    () => checker.describe(doc, true),
  );
  await vscode.commands.executeCommand("workbench.actions.view.problems");
}

function problemLines(file: string, problems: readonly InfraenvProblem[]): string[] {
  return problems.map(
    (p) => `${file}${p.line > 0 ? `:${p.line}` : ""} ${p.key ? `${p.key}: ` : ""}${p.message}`,
  );
}

/**
 * Write `text` with mode 0600 through a temporary file renamed over the
 * target, so a reader never sees half a file and a wider mode never survives.
 */
async function writeSecretFile(target: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  try {
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true });
    throw err;
  }
}

async function readIfFile(target: string): Promise<string | null | "not-a-file"> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return "not-a-file";
    return await fs.readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Infrawrench: Pull .env. Resolves the file (the editor's text, saved or not)
 * for one environment and writes the `.env` beside it, where its `output`
 * setting says. Values go straight to disk and are never shown.
 */
export async function pullDotenvCommand(session: Session): Promise<void> {
  const doc = await pickInfraenvDocument();
  if (!doc) return;
  if (doc.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("Pull .env works on files on disk.");
    return;
  }
  if (!(await requireSession(session))) return;
  const api = session.api!;
  const orgId = session.orgId!;
  const file = doc.uri.fsPath;
  const source = doc.getText();
  const { document, problems } = parseInfraenv(source);
  if (problems.length > 0) {
    const show = await vscode.window.showErrorMessage(
      `${path.basename(file)} has ${problems.length === 1 ? "a syntax problem" : `${problems.length} syntax problems`}. Fix ${problems.length === 1 ? "it" : "them"} first.`,
      "Show Problems",
    );
    if (show) await vscode.commands.executeCommand("workbench.actions.view.problems");
    return;
  }

  const environments = infraenvEnvironmentNames(document);
  let environment: string | null = null;
  if (environments.length > 0) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Shared", description: "[env]", environment: null as string | null },
        ...environments.map((name) => ({
          label: name,
          description: `[env] + [env.${name}]`,
          environment: name as string | null,
        })),
      ],
      { title: "Pull .env for which environment?" },
    );
    if (!pick) return;
    environment = pick.environment;
  }

  const target = path.resolve(path.dirname(file), infraenvOutputPath(document));
  const shown = vscode.workspace.asRelativePath(target);
  if (target === file) {
    void vscode.window.showErrorMessage(
      `The output setting points at ${shown} itself. Change it to the .env path.`,
    );
    return;
  }
  const existing = await readIfFile(target);
  if (existing === "not-a-file") {
    void vscode.window.showErrorMessage(`${shown} exists and is not a file.`);
    return;
  }
  if (infraenvPullDecision(existing) === "confirm") {
    const replace = await vscode.window.showWarningMessage(
      `${shown} exists and was not generated by Infrawrench. Replace it?`,
      { modal: true, detail: "Its current contents will be lost." },
      "Replace",
    );
    if (replace !== "Replace") return;
  }

  const sourceName =
    path.relative(path.dirname(target), file).split(path.sep).join("/") || INFRAENV_FILE_NAME;
  const resolved = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Resolving .infraenv" },
    () => fetchInfraenvResolve(api, orgId, { source, environment, sourceName }),
  );
  await writeSecretFile(target, resolved.dotenv);

  const count = resolved.values.length;
  const wrote = `Wrote ${count} variable${count === 1 ? "" : "s"} to ${shown}${environment ? ` (${environment})` : ""}.`;
  if (resolved.problems.length === 0) {
    void vscode.window.showInformationMessage(wrote);
    return;
  }
  const channel = outputChannel();
  channel.appendLine(`${wrote} Not resolved:`);
  for (const line of problemLines(vscode.workspace.asRelativePath(file), resolved.problems)) {
    channel.appendLine(`  ${line}`);
  }
  const n = resolved.problems.length;
  const details = await vscode.window.showWarningMessage(
    `${wrote} ${n} variable${n === 1 ? "" : "s"} did not resolve and ${n === 1 ? "was" : "were"} left out.`,
    "Show Details",
  );
  if (details) channel.show(true);
}

type SourceItem = vscode.QuickPickItem & { source?: InfraenvSource };

/** A quick pick over `/env-files/sources`, searched as the user types. */
function pickSource(
  session: Session,
): Promise<{ source: InfraenvSource; loaded: InfraenvSource[] } | null> {
  const api = session.api!;
  const orgId = session.orgId!;
  const qp = vscode.window.createQuickPick<SourceItem>();
  qp.title = "Insert a reference to which resource?";
  qp.placeholder = "Resource name, type or account";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  let loaded: InfraenvSource[] = [];
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (q: string) => {
    const mine = ++generation;
    qp.busy = true;
    void fetchInfraenvSources(api, orgId, { q, limit: 50 })
      .then((sources) => {
        if (mine !== generation) return;
        loaded = sources;
        qp.items =
          sources.length > 0
            ? sources.map((s) => ({
                label: s.displayName,
                description: `${s.pluginName} ${s.resourceTypeName}`,
                detail: s.accountName,
                source: s,
              }))
            : [{ label: "No resources with outputs match", alwaysShow: true }];
      })
      .catch((err: unknown) => {
        if (mine !== generation) return;
        qp.items = [
          {
            label: "$(error) Couldn't list resources",
            detail: err instanceof Error ? err.message : String(err),
            alwaysShow: true,
          },
        ];
      })
      .finally(() => {
        if (mine === generation) qp.busy = false;
      });
  };
  return new Promise((resolve) => {
    let done = false;
    qp.onDidChangeValue((value) => {
      clearTimeout(timer);
      timer = setTimeout(() => update(value), 250);
    });
    qp.onDidAccept(() => {
      const source = qp.selectedItems[0]?.source;
      if (!source) return;
      done = true;
      resolve({ source, loaded });
      qp.hide();
    });
    qp.onDidHide(() => {
      clearTimeout(timer);
      if (!done) resolve(null);
      qp.dispose();
    });
    update("");
    qp.show();
  });
}

async function pickOutput(source: InfraenvSource): Promise<InfraenvSourceOutput | null> {
  if (source.outputs.length === 1) return source.outputs[0]!;
  const pick = await vscode.window.showQuickPick(
    source.outputs.map((o) => ({
      label: o.label || o.key,
      description: o.key,
      ...(o.sensitive ? { detail: "Sensitive" } : {}),
      output: o,
    })),
    { title: `Which output of ${source.displayName}?` },
  );
  return pick?.output ?? null;
}

/**
 * Infrawrench: Insert Resource Reference. Picks a resource and one of its
 * outputs, asks for the variable name (suggested by the type), and inserts a
 * by-name reference with a comment naming what it points at.
 */
export async function insertInfraenvReferenceCommand(session: Session): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isInfraenvDocument(editor.document)) {
    void vscode.window.showWarningMessage("Open an .infraenv file first.");
    return;
  }
  const cursor = editor.selection.active.line;
  const section = infraenvSectionAt(editor.document.getText(), cursor + 1);
  if (section.kind !== "env") {
    void vscode.window.showWarningMessage(
      "Put the cursor in an [env] or [env.<name>] section first.",
    );
    return;
  }
  if (!(await requireSession(session))) return;
  const picked = await pickSource(session);
  if (!picked) return;
  const outputPick = await pickOutput(picked.source);
  if (!outputPick) return;

  const taken = infraenvKeysIn(
    parseInfraenv(editor.document.getText()).document,
    section.environment,
  );
  const key = await vscode.window.showInputBox({
    title: "Variable name",
    value: uniqueInfraenvKey(infraenvKeyForOutput(outputPick), taken),
    validateInput: (v) =>
      !isInfraenvKey(v.trim())
        ? "Letters, digits and _, not starting with a digit"
        : taken.includes(v.trim())
          ? `${v.trim()} is already set in this section`
          : null,
  });
  if (!key) return;

  const lines = infraenvReferenceLines(key.trim(), picked.source, outputPick, picked.loaded);
  const doc = editor.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const line = doc.lineAt(Math.min(editor.selection.active.line, doc.lineCount - 1));
  const ok = await editor.edit((edit) => {
    if (line.isEmptyOrWhitespace) edit.replace(line.range, lines.join(eol));
    else edit.insert(line.range.end, eol + lines.join(eol));
  });
  if (!ok) return;
  const keyLine = line.isEmptyOrWhitespace ? line.lineNumber + 1 : line.lineNumber + 2;
  const end = doc.lineAt(Math.min(keyLine, doc.lineCount - 1)).range.end;
  editor.selection = new vscode.Selection(end, end);
}

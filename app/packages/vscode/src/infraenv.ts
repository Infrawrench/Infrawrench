import * as vscode from "vscode";
import {
  INFRAENV_LIMITS,
  checkInfraenvReference,
  fetchInfraenvDescribe,
  infraenvDiagnostics,
  infraenvReferenceAt,
  parseInfraenv,
  type InfraenvDescribeResponse,
} from "@infrawrench/client-core";
import { INFRAENV_HOVER_COMMANDS, infraenvHoverMarkdown } from "./infraenv-format";
import type { Session } from "./session";

export const INFRAENV_LANGUAGE = "infraenv";
export const INFRAENV_SELECTOR: vscode.DocumentSelector = [{ language: INFRAENV_LANGUAGE }];

/** Syntax is checked this long after the last keystroke. */
const SYNTAX_DELAY_MS = 150;
/** References (a request) this long after the last keystroke. */
const DESCRIBE_DELAY_MS = 1200;

interface Described {
  readonly version: number;
  readonly lineCount: number;
  readonly response: InfraenvDescribeResponse;
}

interface DocState {
  /** Bumped by every describe started; a result whose number is not the latest is dropped. */
  seq: number;
  described: Described | null;
  inflight: {
    seq: number;
    version: number;
    promise: Promise<InfraenvDescribeResponse | null>;
  } | null;
  failure: string | null;
  syntaxTimer?: ReturnType<typeof setTimeout> | undefined;
  describeTimer?: ReturnType<typeof setTimeout> | undefined;
}

export function isInfraenvDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === INFRAENV_LANGUAGE;
}

/**
 * Diagnostics for open `.infraenv` documents: syntax problems offline on
 * every change, and dangling references from `POST /env-files/describe` when
 * signed in (on open and save, and after typing pauses). A describe answers
 * for the text it was sent; a newer one supersedes it, and a stale answer
 * never overwrites a newer one. Signed out, only syntax is checked and the
 * status bar says how to get the rest.
 */
export class InfraenvChecker implements vscode.Disposable, vscode.HoverProvider {
  private readonly collection = vscode.languages.createDiagnosticCollection("infraenv");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  private readonly states = new Map<string, DocState>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly session: Session) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.opened(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.changed(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isInfraenvDocument(doc)) this.scheduleDescribe(doc, 0);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.closed(doc)),
      vscode.window.onDidChangeActiveTextEditor(() => this.renderStatus()),
      session.onDidChange(() => this.sessionChanged()),
    );
    for (const doc of vscode.workspace.textDocuments) this.opened(doc);
  }

  dispose(): void {
    for (const st of this.states.values()) {
      clearTimeout(st.syntaxTimer);
      clearTimeout(st.describeTimer);
    }
    this.states.clear();
    for (const d of this.disposables) d.dispose();
    this.collection.dispose();
    this.status.dispose();
  }

  private state(doc: vscode.TextDocument): DocState {
    const key = doc.uri.toString();
    let st = this.states.get(key);
    if (!st) {
      st = { seq: 0, described: null, inflight: null, failure: null };
      this.states.set(key, st);
    }
    return st;
  }

  private opened(doc: vscode.TextDocument): void {
    if (!isInfraenvDocument(doc)) return;
    this.render(doc);
    this.scheduleDescribe(doc, 0);
  }

  private changed(doc: vscode.TextDocument): void {
    if (!isInfraenvDocument(doc)) return;
    const st = this.state(doc);
    clearTimeout(st.syntaxTimer);
    st.syntaxTimer = setTimeout(() => this.render(doc), SYNTAX_DELAY_MS);
    this.scheduleDescribe(doc, DESCRIBE_DELAY_MS);
  }

  private closed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const st = this.states.get(key);
    if (st) {
      clearTimeout(st.syntaxTimer);
      clearTimeout(st.describeTimer);
      // Any describe still in flight is now stale.
      st.seq++;
    }
    this.states.delete(key);
    this.collection.delete(doc.uri);
    this.renderStatus();
  }

  private sessionChanged(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (!isInfraenvDocument(doc)) continue;
      const st = this.state(doc);
      st.seq++;
      st.described = null;
      st.inflight = null;
      st.failure = null;
      this.render(doc);
      this.scheduleDescribe(doc, 0);
    }
    this.renderStatus();
  }

  private scheduleDescribe(doc: vscode.TextDocument, delay: number): void {
    const st = this.state(doc);
    clearTimeout(st.describeTimer);
    st.describeTimer = setTimeout(() => void this.describe(doc), delay);
  }

  /**
   * The describe of the document's current text: cached, in flight, or a new
   * request. Null when signed out, the file is too large, or the request failed.
   */
  describe(doc: vscode.TextDocument, force = false): Promise<InfraenvDescribeResponse | null> {
    const api = this.session.api;
    const orgId = this.session.orgId;
    if (!api || !orgId || doc.isClosed) {
      this.renderStatus();
      return Promise.resolve(null);
    }
    const st = this.state(doc);
    const version = doc.version;
    if (!force && st.described?.version === version) {
      return Promise.resolve(st.described.response);
    }
    if (!force && st.inflight?.version === version) return st.inflight.promise;
    const source = doc.getText();
    if (source.length > INFRAENV_LIMITS.maxSourceLength) {
      st.failure = `the file is larger than ${INFRAENV_LIMITS.maxSourceLength / 1024} KiB`;
      this.renderStatus();
      return Promise.resolve(null);
    }
    const seq = ++st.seq;
    const lineCount = doc.lineCount;
    const promise = fetchInfraenvDescribe(api, orgId, { source })
      .then((response) => {
        if (st.seq === seq) {
          st.described = { version, lineCount, response };
          st.failure = null;
          if (!doc.isClosed) this.render(doc);
        }
        return response;
      })
      .catch((err: unknown) => {
        if (st.seq === seq) st.failure = err instanceof Error ? err.message : String(err);
        return null;
      })
      .finally(() => {
        if (st.inflight?.seq === seq) st.inflight = null;
        this.renderStatus();
      });
    st.inflight = { seq, version, promise };
    this.renderStatus();
    return promise;
  }

  /**
   * The latest describe that still lines up with the text: the same version,
   * or a text with the same number of lines (typing within a line keeps the
   * reference warnings in place until the next describe lands).
   */
  private describedFor(doc: vscode.TextDocument): InfraenvDescribeResponse | null {
    const d = this.states.get(doc.uri.toString())?.described;
    if (!d) return null;
    return d.version === doc.version || d.lineCount === doc.lineCount ? d.response : null;
  }

  private render(doc: vscode.TextDocument): void {
    if (doc.isClosed) return;
    const diagnostics = infraenvDiagnostics(doc.getText(), this.describedFor(doc)).map((d) => {
      const lineNo = Math.min(Math.max(d.line - 1, 0), doc.lineCount - 1);
      const line = doc.lineAt(lineNo);
      const range =
        d.line === 0
          ? new vscode.Range(0, 0, 0, line.range.end.character)
          : new vscode.Range(
              lineNo,
              line.firstNonWhitespaceCharacterIndex,
              lineNo,
              line.range.end.character,
            );
      const diagnostic = new vscode.Diagnostic(
        range,
        d.message,
        d.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = "infraenv";
      return diagnostic;
    });
    this.collection.set(doc.uri, diagnostics);
  }

  private renderStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isInfraenvDocument(doc)) {
      this.status.hide();
      return;
    }
    if (!this.session.api) {
      this.status.text = "$(info) .infraenv: syntax only";
      this.status.tooltip = "Sign in to Infrawrench to check references";
      this.status.command = "infrawrench.signIn";
      this.status.show();
      return;
    }
    const st = this.states.get(doc.uri.toString());
    if (st?.inflight) {
      this.status.text = "$(sync~spin) .infraenv";
      this.status.tooltip = "Checking references";
      this.status.command = undefined;
      this.status.show();
    } else if (st?.failure) {
      this.status.text = "$(warning) .infraenv: references unchecked";
      this.status.tooltip = st.failure;
      this.status.command = "infrawrench.checkInfraenv";
      this.status.show();
    } else {
      this.status.hide();
    }
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | null> {
    const source = document.getText();
    const at = infraenvReferenceAt(source, position.line + 1, position.character);
    if (!at) return null;
    const signedIn = Boolean(this.session.api);
    const response = signedIn ? await this.describe(document) : null;
    // The text may have moved on while the request ran.
    if (document.getText() !== source) return null;
    const checks = checkInfraenvReference(parseInfraenv(source).document, at, response);
    const md = new vscode.MarkdownString(
      infraenvHoverMarkdown(at, checks, {
        signedIn,
        failure: this.states.get(document.uri.toString())?.failure,
      }),
      true,
    );
    md.isTrusted = { enabledCommands: INFRAENV_HOVER_COMMANDS };
    md.supportHtml = false;
    return new vscode.Hover(md, new vscode.Range(position.line, at.start, position.line, at.end));
  }
}

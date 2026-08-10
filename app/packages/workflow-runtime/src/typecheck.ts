/**
 * Server-side type checking for a workflow's source against its generated
 * `infra.d.ts`.
 *
 * The Monaco editor already type-checks interactively in the browser, but
 * non-interactive authors (the MCP / chat `write_workflow` tool, scripts, the
 * HTTP API) have no editor. This runs the same check headlessly so a workflow
 * can be rejected — with real diagnostics — before it is ever saved.
 *
 * The compiler options mirror {@link file://../../ui/src/workflows/WorkflowEditorView.tsx}
 * exactly (target ESNext, `lib: ["es2020"]`, non-strict) so the diagnostics an
 * agent sees are the diagnostics a human would see in the editor.
 */
import ts from "@typescript/typescript6";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Virtual file names the program is built from. */
const WORKFLOW_FILE = "workflow.ts";
const INFRA_FILE = "infra.d.ts";

/** The lib file the workflow is checked against (must exist in the lib dir). */
const ROOT_LIB = "lib.es2020.d.ts";

/** Only ever read files matching this out of the resolved lib directory. */
const LIB_FILE_RE = /^lib\..*\.d\.ts$/;

export interface WorkflowDiagnostic {
  /** 1-based line in the workflow source. 0 when the position is unknown. */
  line: number;
  /** 1-based column. 0 when the position is unknown. */
  column: number;
  /** TypeScript diagnostic code, e.g. 2339. */
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
  message: string;
}

export interface TypecheckResult {
  diagnostics: WorkflowDiagnostic[];
  /** True when at least one diagnostic has `category: "error"`. */
  hasErrors: boolean;
  /**
   * True when the TypeScript standard library could not be located, so only
   * syntax was checked. Callers should surface this — a clean result is much
   * weaker than a full check.
   */
  degraded: boolean;
}

export interface TypecheckWorkflowOptions {
  source: string;
  /** The generated ambient typings (see `generateInfraDts`). */
  dts: string;
  /** Override the lib directory (tests); otherwise auto-resolved. */
  libDir?: string;
  /** Cap on returned diagnostics. Default 50. */
  limit?: number;
}

let cachedLibDir: string | null | undefined;

/**
 * Where to look for `lib.*.d.ts`, in order. Bundled services (esbuild) lose the
 * ability to resolve the TypeScript package at runtime — lib files are data,
 * not code — so `scripts/copy-ts-libs.mjs` drops them next to the bundle and
 * candidate #2 (sibling `ts-libs/`) finds them there.
 *
 * Note: `@typescript/typescript6` re-exports `typescript@^6` via
 * `@typescript/old`; its package-root `lib/` only has JS stubs. Always use
 * `getDefaultLibFilePath` (not `dirname(require.resolve(...))`) for the real
 * `lib.*.d.ts` directory.
 */
function libDirCandidates(): string[] {
  const out: string[] = [];
  const override = process.env["INFRAWRENCH_TS_LIB_DIR"];
  if (override) out.push(override);
  try {
    out.push(join(dirname(fileURLToPath(import.meta.url)), "ts-libs"));
  } catch {
    /* import.meta.url unavailable (CJS interop) — skip */
  }
  try {
    out.push(dirname(ts.getDefaultLibFilePath({})));
  } catch {
    /* ts.sys unavailable — skip */
  }
  return out;
}

/** True when `dir` actually holds the standard library we check against. */
function hasStandardLib(dir: string): boolean {
  return !!dir && existsSync(join(dir, ROOT_LIB));
}

/** The directory holding `lib.*.d.ts`, or null when none could be found. */
export function resolveTsLibDir(): string | null {
  if (cachedLibDir !== undefined) return cachedLibDir;
  cachedLibDir = libDirCandidates().find(hasStandardLib) ?? null;
  return cachedLibDir;
}

function categoryOf(category: ts.DiagnosticCategory): WorkflowDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

/**
 * Type-check a workflow body. Returns editor-equivalent diagnostics positioned
 * against the *original* source (1-based line/column).
 */
export function typecheckWorkflow(opts: TypecheckWorkflowOptions): TypecheckResult {
  // An override that doesn't actually hold the libs degrades the same way a
  // missing install does — never silently pass off a lib-less check as a real one.
  const override = opts.libDir;
  const libDir = override ? (hasStandardLib(override) ? override : null) : resolveTsLibDir();
  const limit = opts.limit ?? 50;

  // The sandbox evaluates the body as a module (see `buildProgram`), which is
  // what makes top-level `await` legal. Appending the marker rather than
  // prepending it keeps every original line number intact.
  const source = `${opts.source}\nexport {};\n`;

  const virtual = new Map<string, string>([
    [INFRA_FILE, opts.dts],
    [WORKFLOW_FILE, source],
  ]);

  const readLib = (fileName: string): string | undefined => {
    if (!libDir) return undefined;
    if (dirname(fileName) !== libDir || !LIB_FILE_RE.test(basename(fileName))) return undefined;
    try {
      return readFileSync(fileName, "utf8");
    } catch {
      return undefined;
    }
  };

  const readFile = (fileName: string): string | undefined =>
    virtual.get(fileName) ?? readLib(fileName);

  const host: ts.CompilerHost = {
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile,
    getSourceFile: (fileName, languageVersion) => {
      const text = readFile(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => (libDir ? join(libDir, ROOT_LIB) : ROOT_LIB),
    getDefaultLibLocation: () => libDir ?? "",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };

  const program = ts.createProgram({
    rootNames: [INFRA_FILE, WORKFLOW_FILE],
    options: {
      // Mirrors the Monaco editor's options so headless and in-editor
      // diagnostics agree.
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: [ROOT_LIB],
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
      types: [],
      ...(libDir ? {} : { noLib: true }),
    },
    host,
  });

  const sf = program.getSourceFile(WORKFLOW_FILE);
  const raw = sf
    ? [
        ...program.getSyntacticDiagnostics(sf),
        ...(libDir ? program.getSemanticDiagnostics(sf) : []),
      ]
    : [];

  const diagnostics: WorkflowDiagnostic[] = raw.slice(0, limit).map((d) => {
    const pos =
      d.file && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start)
        : { line: -1, character: -1 };
    return {
      line: pos.line + 1,
      column: pos.character + 1,
      code: d.code,
      category: categoryOf(d.category),
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    };
  });

  return {
    diagnostics,
    hasErrors: diagnostics.some((d) => d.category === "error"),
    degraded: !libDir,
  };
}

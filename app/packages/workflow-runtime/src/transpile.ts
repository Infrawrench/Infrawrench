/**
 * Runtime TypeScript -> JavaScript transform. This only strips/transforms
 * syntax; it never type-checks (editor diagnostics handle that).
 *
 * We use the TypeScript compiler's `transpileModule` rather than esbuild so the
 * exact same code path runs in Node (web server, poller) AND in a browser-like
 * Electron renderer (where the desktop isolate runs and a native esbuild binary
 * is unavailable). `transpileModule` is pure JS and single-file.
 */
import ts from "typescript";

export interface TranspileResult {
  code: string;
  warnings: string[];
}

export async function transpileWorkflow(source: string): Promise<TranspileResult> {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // Single-file transform: don't resolve imports/types across files.
      isolatedModules: true,
      verbatimModuleSyntax: false,
      useDefineForClassFields: true,
      inlineSourceMap: false,
      sourceMap: false,
    },
    reportDiagnostics: false,
  });
  return { code: out.outputText, warnings: [] };
}

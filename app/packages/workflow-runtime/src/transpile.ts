/**
 * Runtime TypeScript -> JavaScript transform. This only strips/transforms
 * syntax; it never type-checks (editor diagnostics handle that).
 *
 * We use the TypeScript compiler's `transpileModule` rather than esbuild so the
 * exact same code path runs in Node (web server, poller) AND in a browser-like
 * Electron renderer (where the desktop isolate runs and a native esbuild binary
 * is unavailable). `transpileModule` is pure JS and single-file.
 */
import ts from "@typescript/typescript6";

export interface TranspileResult {
  code: string;
  warnings: string[];
}

interface TranspileOptions {
  /**
   * Inject `await __line(n)` before each statement (n = 1-based source line),
   * so a debugger can highlight the current line and pause at breakpoints. Only
   * statements in the async top-level scope are instrumented — we never descend
   * into function/arrow/method bodies, which keeps every injected `await` inside
   * the async `__task` wrapper (see sandbox.ts).
   */
  instrumentLines?: boolean;
}

/** A TS transformer that prepends `await __line(<line>)` before each statement. */
function lineMarkerTransformer(): ts.TransformerFactory<ts.SourceFile> {
  return (context) => (sf) => {
    const f = context.factory;

    const marker = (line: number): ts.Statement =>
      f.createExpressionStatement(
        f.createAwaitExpression(
          f.createCallExpression(f.createIdentifier("__line"), undefined, [
            f.createNumericLiteral(line),
          ]),
        ),
      );

    const isFunctionLike = (node: ts.Node): boolean =>
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node);

    const visit = (node: ts.Node): ts.Node => {
      // Don't instrument inside function bodies — an injected `await` there
      // would land in a (possibly non-async) nested scope.
      if (isFunctionLike(node)) return node;
      if (ts.isBlock(node)) {
        return f.updateBlock(node, instrument(node.statements));
      }
      return ts.visitEachChild(node, visit, context);
    };

    const instrument = (statements: ts.NodeArray<ts.Statement>): ts.Statement[] => {
      const out: ts.Statement[] = [];
      for (const stmt of statements) {
        const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        out.push(marker(line));
        out.push(ts.visitNode(stmt, visit) as ts.Statement);
      }
      return out;
    };

    return f.updateSourceFile(sf, instrument(sf.statements));
  };
}

export async function transpileWorkflow(
  source: string,
  opts: TranspileOptions = {},
): Promise<TranspileResult> {
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
    ...(opts.instrumentLines ? { transformers: { before: [lineMarkerTransformer()] } } : {}),
  });
  return { code: out.outputText, warnings: [] };
}

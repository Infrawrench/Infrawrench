import type { OnMount } from "@monaco-editor/react";
import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { useGT } from "gt-react";

const Editor = lazy(() => import("@monaco-editor/react"));

interface WorkflowEditorViewProps {
  value: string;
  onChange: (value: string) => void;
  /** Generated `infra.d.ts` injected as an ambient lib for IntelliSense. */
  dts: string;
  onSave?: () => void;
  readOnly?: boolean;
  /** 1-based lines with breakpoints (for the gutter glyphs). */
  breakpoints?: ReadonlySet<number>;
  /** Toggle a breakpoint when the user clicks the gutter. */
  onToggleBreakpoint?: (line: number) => void;
  /** The line currently executing (live highlight), or null. */
  currentLine?: number | null;
  /** The line execution is paused on (breakpoint), or null. */
  pausedLine?: number | null;
}

const INFRA_DTS_PATH = "ts:infra-workflow.d.ts";

// Monaco decoration classNames need global CSS; inject it once.
const DECORATION_STYLE_ID = "iw-workflow-debug-decorations";
function ensureDecorationStyles(): void {
  if (typeof document === "undefined" || document.getElementById(DECORATION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = DECORATION_STYLE_ID;
  style.textContent = `
    .iw-wf-current-line { background: rgba(250, 204, 21, 0.12); }
    .iw-wf-paused-line { background: rgba(248, 113, 113, 0.18); }
    .iw-wf-current-glyph::before,
    .iw-wf-paused-glyph::before {
      content: ""; display: inline-block; width: 0; height: 0;
      border-top: 5px solid transparent; border-bottom: 5px solid transparent;
      border-left: 7px solid #facc15; margin-left: 6px; vertical-align: middle;
    }
    .iw-wf-paused-glyph::before { border-left-color: #f87171; }
    .iw-wf-breakpoint-glyph::before {
      content: ""; display: inline-block; width: 10px; height: 10px;
      border-radius: 50%; background: #ef4444; margin-left: 5px; vertical-align: middle;
    }
    .iw-wf-breakpoint-margin { cursor: pointer; }
  `;
  document.head.appendChild(style);
}

/**
 * Monaco TypeScript editor for a workflow. Injects the account-derived
 * `infra.d.ts` so authors get autocomplete and type-checking against their own
 * connected accounts and declared metrics, and renders the live debugger's
 * current/paused line + gutter breakpoints.
 */
export function WorkflowEditorView({
  value,
  onChange,
  dts,
  onSave,
  readOnly,
  breakpoints,
  onToggleBreakpoint,
  currentLine,
  pausedLine,
}: WorkflowEditorViewProps) {
  const gt = useGT();
  type Monaco = Parameters<OnMount>[1];
  type Editor = Parameters<OnMount>[0];
  // Keep references so we can re-inject typings/decorations when props change.
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  onToggleBreakpointRef.current = onToggleBreakpoint;

  const applyTypings = useCallback((monaco: Monaco, dtsValue: string) => {
    const ts = monaco.languages.typescript;
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      allowNonTsExtensions: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      module: ts.ModuleKind.ESNext,
      lib: ["es2020"],
      strict: false,
      noEmit: true,
    });
    // The workflow body runs wrapped in a module + async IIFE (see the sandbox),
    // so top-level `await` is valid. The editor sees the raw source as a script
    // (no import/export), so silence the "not a module" / "needs esnext module"
    // top-level-await diagnostics (TS 1375 / 1378).
    ts.typescriptDefaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: [1375, 1378] });
    ts.typescriptDefaults.setEagerModelSync(true);
    ts.typescriptDefaults.addExtraLib(dtsValue, INFRA_DTS_PATH);
  }, []);

  // Recompute decorations (breakpoints + current/paused line) whenever they change.
  const applyDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const decorations: Parameters<typeof editor.deltaDecorations>[1] = [];
    for (const line of breakpoints ?? []) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "iw-wf-breakpoint-glyph iw-wf-breakpoint-margin",
          glyphMarginHoverMessage: { value: gt("Breakpoint") },
        },
      });
    }
    if (pausedLine != null) {
      decorations.push({
        range: new monaco.Range(pausedLine, 1, pausedLine, 1),
        options: {
          isWholeLine: true,
          className: "iw-wf-paused-line",
          glyphMarginClassName: "iw-wf-paused-glyph",
        },
      });
    } else if (currentLine != null) {
      decorations.push({
        range: new monaco.Range(currentLine, 1, currentLine, 1),
        options: {
          isWholeLine: true,
          className: "iw-wf-current-line",
          glyphMarginClassName: "iw-wf-current-glyph",
        },
      });
    }
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }, [breakpoints, currentLine, pausedLine, gt]);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      ensureDecorationStyles();
      monacoRef.current = monaco;
      editorRef.current = editor;
      applyTypings(monaco, dts);
      applyDecorations();
      // Cmd/Ctrl+S → save
      editor.addAction({
        id: "workflow-save",
        label: gt("Save workflow"),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current?.(),
      });
      // Click the gutter glyph margin to toggle a breakpoint on that line.
      editor.onMouseDown((e) => {
        if (
          e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
          e.target.position
        ) {
          onToggleBreakpointRef.current?.(e.target.position.lineNumber);
        }
      });
    },
    [applyTypings, applyDecorations, dts, gt],
  );

  // Re-inject typings when the generated dts changes (accounts/metrics edited).
  useEffect(() => {
    if (monacoRef.current) applyTypings(monacoRef.current, dts);
  }, [dts, applyTypings]);

  // Re-render decorations whenever breakpoints / current / paused line change.
  useEffect(() => {
    applyDecorations();
  }, [applyDecorations]);

  return (
    <Suspense
      fallback={<div className="flex-1 p-4 text-sm opacity-60">{gt("Loading editor…")}</div>}
    >
      <Editor
        defaultLanguage="typescript"
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        theme="vs-dark"
        options={{
          readOnly: Boolean(readOnly),
          minimap: { enabled: false },
          glyphMargin: true,
          fontSize: 13,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
        }}
      />
    </Suspense>
  );
}

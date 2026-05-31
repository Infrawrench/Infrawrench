import type { OnMount } from "@monaco-editor/react";
import { lazy, Suspense, useCallback, useEffect, useRef } from "react";

const Editor = lazy(() => import("@monaco-editor/react"));

interface WorkflowEditorViewProps {
  value: string;
  onChange: (value: string) => void;
  /** Generated `infra.d.ts` injected as an ambient lib for IntelliSense. */
  dts: string;
  onSave?: () => void;
  readOnly?: boolean;
}

const INFRA_DTS_PATH = "ts:infra-workflow.d.ts";

/**
 * Monaco TypeScript editor for a workflow. Injects the account-derived
 * `infra.d.ts` so authors get autocomplete and type-checking against their own
 * connected accounts and declared metrics.
 */
export function WorkflowEditorView({
  value,
  onChange,
  dts,
  onSave,
  readOnly,
}: WorkflowEditorViewProps) {
  // Keep references so we can re-inject typings whenever the dts changes.
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const applyTypings = useCallback((monaco: Parameters<OnMount>[1], dtsValue: string) => {
    const ts = monaco.languages.typescript;
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      module: ts.ModuleKind.ESNext,
      lib: ["es2020"],
      strict: false,
      noEmit: true,
    });
    ts.typescriptDefaults.setEagerModelSync(true);
    ts.typescriptDefaults.addExtraLib(dtsValue, INFRA_DTS_PATH);
  }, []);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      monacoRef.current = monaco;
      applyTypings(monaco, dts);
      // Cmd/Ctrl+S → save
      editor.addAction({
        id: "workflow-save",
        label: "Save workflow",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current?.(),
      });
    },
    [applyTypings, dts],
  );

  // Re-inject typings when the generated dts changes (accounts/metrics edited).
  useEffect(() => {
    if (monacoRef.current) applyTypings(monacoRef.current, dts);
  }, [dts, applyTypings]);

  return (
    <Suspense fallback={<div className="flex-1 p-4 text-sm opacity-60">Loading editor…</div>}>
      <Editor
        defaultLanguage="typescript"
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        theme="vs-dark"
        options={{
          readOnly: Boolean(readOnly),
          minimap: { enabled: false },
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

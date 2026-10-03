import type { WorkflowMetricDef, WorkflowSecretSummary } from "./types.js";

function metricTsType(type: WorkflowMetricDef["type"]): string {
  return type === "number" ? "number" : type === "boolean" ? "boolean" : "string";
}
/**
 * Render the `InfraMetrics` interface for a set of declared metrics. Mirrors
 * the server-side codegen (`generateInfraDts`) byte-for-byte so the live
 * overlay below and the saved typings agree (no hover flicker after Save).
 */
function renderMetricsInterface(defs: WorkflowMetricDef[]): string {
  if (defs.length === 0) {
    return "interface InfraMetrics {\n  [key: string]: number | string | boolean | null;\n}";
  }
  const props = defs
    .map((m) => {
      const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.key) ? m.key : JSON.stringify(m.key);
      const unit = m.unit ? ` (${m.unit})` : "";
      return `  /** ${m.label}${unit} — read/write; \`null\` until first set. */\n  ${prop}: ${metricTsType(m.type)} | null;`;
    })
    .join("\n");
  return `interface InfraMetrics {\n${props}\n}`;
}
/**
 * Swap the `InfraMetrics` block in the generated typings for one reflecting the
 * metrics the user is *currently* editing, so `infra.metrics.<key>` is typed
 * live: before the workflow is even saved.
 */
export function overlayMetricTypings(dts: string, defs: WorkflowMetricDef[]): string {
  const block = renderMetricsInterface(defs);
  const re = /interface InfraMetrics \{[\s\S]*?\n\}/;
  return re.test(dts) ? dts.replace(re, block) : `${dts}\n${block}\n`;
}
export function overlaySecretTypings(dts: string, secrets: WorkflowSecretSummary[]): string {
  type Node = { value: boolean; children: Map<string, Node> };
  const root: Node = { value: false, children: new Map() };
  for (const secret of secrets) {
    const parts = secret.name.split(".");
    if (parts.some((part) => !SECRET_NAME_RE.test(part))) continue;
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { value: false, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.value = true;
  }
  const render = (node: Node, indent: string): string =>
    [...node.children.entries()]
      .map(([name, child]) => {
        if (child.children.size === 0) return `${indent}readonly ${name}: string;`;
        if (child.value) {
          // Corrupt/legacy assignments may contain both `stripe` and
          // `stripe.apiKey`. The service rejects that shape; keep the editor
          // fail-closed if it still arrives instead of silently dropping one.
          return `${indent}readonly ${name}: never;`;
        }
        return `${indent}readonly ${name}: {\n${render(child, `${indent}  `)}\n${indent}};`;
      })
      .join("\n");
  const block = `interface InfraSecrets {\n${render(root, "  ")}\n}`;
  const marker = "interface InfraSecrets {";
  const start = dts.indexOf(marker);
  let withSecrets: string;
  if (start < 0) {
    withSecrets = `${dts}\n${block}\n`;
  } else {
    let depth = 0;
    let end = -1;
    for (let i = dts.indexOf("{", start); i < dts.length; i += 1) {
      if (dts[i] === "{") depth += 1;
      if (dts[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    withSecrets =
      end < 0 ? `${dts}\n${block}\n` : `${dts.slice(0, start)}${block}${dts.slice(end)}`;
  }
  return /interface InfraApi \{[\s\S]*?readonly secrets: InfraSecrets;/.test(withSecrets)
    ? withSecrets
    : `${withSecrets}\ninterface InfraApi {\n  readonly secrets: InfraSecrets;\n}\n`;
}
const SECRET_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const SECRET_PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

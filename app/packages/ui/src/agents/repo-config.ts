/**
 * Helpers for the repo-provided agent config (`.infrawrench/agent.json`) and
 * the per-session env file delivered to the VM. Pure module — imported by
 * the desktop renderer and unit tests.
 */

/** Where the launch command and setup script look for session env vars. */
export const AGENT_ENV_REMOTE_PATH = ".infrawrench-agent/agent.env";

interface TemplateResource {
  fields: Record<string, unknown>;
  resolvedOutputs: Record<string, unknown>;
}

/**
 * Resolve `{{outputs.<key>}}` / `{{fields.<key>}}` placeholders in an env
 * template against a created resource. Unknown placeholders throw — a half
 * templated connection string is worse than a loud config error.
 */
export function resolveAgentEnvTemplate(template: string, resource: TemplateResource): string {
  return template.replace(/\{\{\s*(outputs|fields)\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, kind, key) => {
    const source = kind === "outputs" ? resource.resolvedOutputs : resource.fields;
    const value = source?.[key];
    if (value === undefined || value === null || String(value) === "") {
      throw new Error(`agent.json env template references missing ${kind}.${key}`);
    }
    return String(value);
  });
}

/**
 * Render env vars as a shell-sourceable file (`KEY='value'` lines). Sourced
 * with `set -a` on the VM, so no `export` prefix is needed. Keys must be
 * valid shell identifiers; values are single-quote escaped.
 */
export function buildAgentEnvFile(env: Record<string, string>): string {
  const lines: string[] = ["# Written by Infrawrench from .infrawrench/agent.json — do not edit."];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`agent.json env key ${JSON.stringify(key)} is not a valid shell identifier`);
    }
    lines.push(`${key}='${value.replace(/'/g, `'\\''`)}'`);
  }
  return `${lines.join("\n")}\n`;
}

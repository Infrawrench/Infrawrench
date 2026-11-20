/**
 * `infraenv check`: what every reference in `.infraenv` points at, and what is
 * broken, without reading a secret value (the describe route needs only
 * `resources:read`). Exits 1 when the server reports a problem.
 */
import {
  checkInfraenvReference,
  infraenvScopeLabel,
  parseInfraenv,
  type InfraenvCheckState,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
} from "@infrawrench/client-core";
import { createApi } from "../api";
import type { ParsedArgs } from "../args";
import { plural, printer, safe, type Io, type Paint } from "../io";
import { display, locateInfraenv, readText } from "../locate";
import { credentialsOrDelegate, explainWrongOrg, resolveOrg } from "../session";
import { problemLine } from "./pull";

function mark(state: InfraenvCheckState, message: string | undefined, c: Paint): string {
  switch (state) {
    case "ok":
      return c.green("✓");
    case "warning":
      return c.yellow(`! ${safe(message ?? "check this")}`);
    case "error":
      return c.red(`✗ ${safe(message ?? "broken")}`);
    case "unchecked":
      return c.dim("? not checked");
  }
}

/**
 * Each section's variables, `[env]` first, with what each reference points
 * at (client-core's `checkInfraenvReference`, the editors' check). An `[env]`
 * line that expands differently in an environment that inherits it gets a
 * line of its own under it, `in <environment>: ...`.
 */
export function sectionLines(
  document: InfraenvDocument,
  overrides: Readonly<Record<string, string>>,
  described: InfraenvDescribeResponse,
  c: Paint,
): string[] {
  const sections = [
    { name: "[env]", scope: null as string | null, entries: document.shared },
    ...document.environments.map((env) => ({
      name: `[env.${env.name}]`,
      scope: env.name,
      entries: env.entries,
    })),
  ];
  const width = Math.max(
    0,
    ...sections.flatMap((section) => section.entries.map((entry) => entry.key.length)),
  );
  const lines: string[] = [];
  for (const section of sections) {
    lines.push("", c.bold(safe(section.name)));
    if (section.entries.length === 0) {
      lines.push(`  ${c.dim("(no variables)")}`);
      continue;
    }
    for (const entry of section.entries) {
      const key = safe(entry.key).padEnd(width);
      if (entry.value.kind === "literal") {
        lines.push(`  ${key}  ${c.dim("literal")}`);
        continue;
      }
      const rows = checkInfraenvReference(
        document,
        { entry, environment: section.scope },
        described,
        overrides,
      );
      rows.forEach((row, index) => {
        // A reference that found nothing has only what it looked for to show.
        const missing = row.value !== null && row.value.kind !== "secret" && !row.resource?.found;
        const label = missing
          ? safe(row.detail)
          : `${safe(row.title)} ${c.dim(`· ${safe(row.detail)}`)}`;
        const scopes =
          index === 0 && row.environments.includes(section.scope)
            ? ""
            : `in ${row.environments.map(infraenvScopeLabel).map(safe).join(", ")}: `;
        const lead = index === 0 ? key : " ".repeat(width);
        lines.push(`  ${lead}  ${scopes}${label}  ${mark(row.state, row.message, c)}`);
      });
    }
  }
  return lines;
}

export async function check(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  const credentials = await credentialsOrDelegate(io, "check", args);
  if ("delegated" in credentials) return credentials.delegated;

  const path = await locateInfraenv(io.cwd, args.file);
  const shown = display(io.cwd, path);
  const source = readText(io.cwd, path);
  const { document } = parseInfraenv(source);
  const api = createApi(credentials);
  const org = await resolveOrg(io, args, credentials, document.settings.org, api.whoami);
  const vars = Object.keys(args.vars).length > 0 ? args.vars : undefined;
  const described = await api
    .describe(org.id, { source, ...(vars ? { vars } : {}) })
    .catch((error: unknown) => explainWrongOrg(error, org, api.whoami));

  if (args.json) {
    p.json({ org: org.id, file: path, ...described });
  } else {
    const { c } = p;
    p.line(`${c.bold(shown)} ${c.dim(`· organization ${safe(org.id)}`)}`);
    p.line(
      c.dim(
        described.environments.length > 0
          ? `environments: ${described.environments.map(safe).join(", ")}`
          : "no environments: [env] only",
      ),
    );
    for (const line of sectionLines(document, args.vars, described, c)) p.line(line);
    p.line();
    if (described.problems.length === 0) {
      p.line(c.green("No problems."));
    } else {
      p.line(c.red(plural(described.problems.length, "problem")));
      for (const problem of described.problems) p.line(`  ${problemLine(shown, problem)}`);
    }
  }
  return described.problems.length > 0 ? 1 : 0;
}

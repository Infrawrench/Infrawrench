// Remediation commands under a finding list (`orphans`, `oversized`,
// `schedules`): the ready-to-run provider CLI lines each plugin generates,
// printed after the table so the table stays scannable. `--json` output
// already carries them as `remediation` on every row.
//
// Type-only import, like the rest of the CLI's client-core use: the rendering
// is a few lines and the CLI ships zero runtime dependencies.
import type { FindingRemediation } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Schema } from "effect";
import { wire } from "./effect/wire";
import { c, println, safe } from "./output";

const Command = Schema.Struct({
  command: Schema.String,
  description: Schema.String,
  destructive: Schema.Boolean,
});

/**
 * The part of a row's `remediation` this section prints, for a migrated
 * command's response schema: `remediation: Schema.optional(Schema.NullOr(Remediation))`.
 */
export const Remediation = wire<FindingRemediation>()(
  Schema.Struct({
    commands: Schema.Array(Command),
    placeholders: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
    iac: Schema.NullOr(Schema.Struct({ address: Schema.String, commands: Schema.Array(Command) })),
  }),
);

export interface RemediationRow {
  readonly displayName: string;
  readonly remediation?: typeof Remediation.Type | null | undefined;
}

/** True when at least one row has a command or a Terraform hint. */
function anyRemediation(rows: readonly RemediationRow[]): boolean {
  return rows.some(
    (r) =>
      (r.remediation?.commands.length ?? 0) > 0 || (r.remediation?.iac?.commands.length ?? 0) > 0,
  );
}

/**
 * Print a "Remediation" section: per resource, the Terraform hint first (when
 * the resource is IaC-managed), then the plugin's commands in run order.
 * Values come from the server, so every line goes through `safe()` before it
 * reaches the terminal.
 */
export function printRemediation(rows: readonly RemediationRow[]): void {
  if (!anyRemediation(rows)) return;
  println();
  println(c.bold("Remediation"));
  const placeholders = new Map<string, string>();
  for (const row of rows) {
    const r = row.remediation;
    if (!r) continue;
    const commands = [...(r.iac?.commands ?? []), ...r.commands];
    if (commands.length === 0) continue;
    for (const p of r.placeholders) placeholders.set(p.name, p.description);
    println();
    println(`  ${c.bold(safe(row.displayName))}`);
    if (r.iac) {
      println(
        c.yellow(
          `    Managed by Terraform at ${safe(r.iac.address)}: change the configuration rather than running the CLI commands.`,
        ),
      );
    }
    for (const cmd of commands) {
      const tag = cmd.destructive ? c.red("[destructive] ") : "";
      println(`    ${c.dim("#")} ${tag}${c.dim(safe(cmd.description))}`);
      println(`    ${safe(cmd.command)}`);
    }
  }
  if (placeholders.size > 0) {
    println();
    println(c.dim("Set these first:"));
    for (const [name, description] of placeholders) {
      println(c.dim(`  export ${safe(name)}=...   # ${safe(description)}`));
    }
  }
}

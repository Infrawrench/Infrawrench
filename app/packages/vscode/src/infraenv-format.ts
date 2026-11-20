import {
  infraenvScopeLabel,
  infraenvValueHasTemplate,
  type InfraenvCheckState,
  type InfraenvReferenceAt,
  type InfraenvReferenceCheck,
} from "@infrawrench/client-core";
import { commandLink, escapeMarkdown } from "./markdown";

/**
 * The `.infraenv` hover's Markdown, kept free of `vscode` so it is testable:
 * which resource or secret the reference under the cursor resolves to, per
 * the describe of the same text, one line per environment when its
 * substitutions make it differ.
 */

export const INFRAENV_HOVER_COMMANDS = ["infrawrench.signIn", "infrawrench.checkInfraenv"];

const ICONS: Record<InfraenvCheckState, string> = {
  ok: "$(pass)",
  warning: "$(warning)",
  error: "$(error)",
  unchecked: "$(circle-large-outline)",
};

function kindLabel(at: InfraenvReferenceAt): string {
  switch (at.value.kind) {
    case "resource":
      return "resource output, by id";
    case "named-resource":
      return "resource output, by name";
    case "secret":
      return "organization secret";
  }
}

export interface HoverOptions {
  readonly signedIn: boolean;
  /** Why the reference could not be checked, when describe failed. */
  readonly failure?: string | null | undefined;
}

export function infraenvHoverMarkdown(
  at: InfraenvReferenceAt,
  checks: readonly InfraenvReferenceCheck[],
  options: HoverOptions,
): string {
  const out = [`**${escapeMarkdown(at.entry.key)}** · ${kindLabel(at)}`, ""];
  const perScope = checks.length > 1 || infraenvValueHasTemplate(at.value);
  for (const check of checks) {
    const scopes = perScope
      ? `${check.environments.map((s) => `\`${escapeMarkdown(infraenvScopeLabel(s))}\``).join(", ")}: `
      : "";
    const parts = [`**${escapeMarkdown(check.title)}**`];
    if (check.detail) parts.push(escapeMarkdown(check.detail));
    if (check.resource?.found && check.resource.sensitive) parts.push("sensitive");
    let line = `${ICONS[check.state]} ${scopes}${parts.join(" · ")}`;
    if (check.message) line += `  \n${escapeMarkdown(check.message)}`;
    out.push(line, "");
  }
  if (checks.some((c) => c.state === "unchecked")) {
    if (!options.signedIn) {
      out.push(`${commandLink("Sign in", "infrawrench.signIn", [])} to check references.`);
    } else if (options.failure) {
      out.push(
        `Couldn't check references: ${escapeMarkdown(options.failure)}. ${commandLink("Retry", "infrawrench.checkInfraenv", [])}`,
      );
    }
  }
  return out.join("\n").trimEnd();
}

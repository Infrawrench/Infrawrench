import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `together` CLI commands for savings findings (`together` is
 * the documented alias of `tg`). The CLI reads its key from the
 * `TOGETHER_API_KEY` environment variable.
 *
 * References:
 * https://docs.together.ai/reference/cli/getting-started
 * https://docs.together.ai/reference/cli/endpoints
 */
export function togetherRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "endpoint") return [];
  const id = remediationId(resource, "endpointId");
  if (!id) return [];
  return [
    {
      tool: "together",
      command: `together endpoints stop ${shellQuote(id)} --wait`,
      description: "Stop the dedicated endpoint, releasing its reserved GPUs and pausing billing.",
      destructive: false,
      placeholders: [API_KEY],
    },
    {
      tool: "together",
      command: `together endpoints start ${shellQuote(id)} --wait`,
      description: "Start the endpoint again; hardware is subject to availability.",
      destructive: false,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "TOGETHER_API_KEY",
  description: "A Together AI API key for this account (the CLI reads it from the environment)",
};

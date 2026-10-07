import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `vastai` CLI commands for savings findings (vast-cli
 * `stop instance`, `start instance`, `destroy instance`, `delete volume`,
 * checked 2026-10). The CLI reads its key from `vastai set api-key`.
 */
export function vastRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;
  const id = (resource.externalId ?? "").trim();
  if (!/^\d+$/.test(id)) return [];
  const target = shellQuote(id);
  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "instance") return [];
    return [
      {
        tool: "vastai",
        command: `vastai stop instance ${target}`,
        description: "Stop the instance; GPU billing stops, disk billing continues.",
        destructive: false,
      },
      {
        tool: "vastai",
        command: `vastai start instance ${target}`,
        description: "Start it again (the host's GPU must still be free).",
        destructive: false,
      },
    ];
  }
  switch (resource.resourceTypeId) {
    case "instance":
      return [
        {
          tool: "vastai",
          command: `vastai destroy instance ${target}`,
          description:
            "Destroy the stopped instance and its disk. Copy anything you need off it first.",
          destructive: true,
        },
      ];
    case "volume":
      return [
        {
          tool: "vastai",
          command: `vastai delete volume ${target}`,
          description: "Delete the unused volume and all of its data.",
          destructive: true,
        },
      ];
    default:
      return [];
  }
}

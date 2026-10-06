import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `runpodctl` commands for savings findings. The CLI reads its
 * key from `runpodctl config --apiKey` and addresses everything by id
 * (runpodctl `cmd/pod/*.go`, `cmd/volume/*.go`, 2026-10).
 *
 * Not covered: Serverless endpoints (an idle endpoint with min workers 0
 * costs nothing) and savings plans, which cannot be cancelled.
 */
export function runpodRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;
  const id = (resource.externalId ?? "").trim();
  if (!id) return [];
  const target = shellQuote(id);

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "pod") return [];
    return [
      {
        tool: "runpodctl",
        command: `runpodctl pod stop ${target}`,
        description: "Stop the pod, which stops GPU billing; its volume is kept and keeps billing.",
        destructive: false,
      },
      {
        tool: "runpodctl",
        command: `runpodctl pod start ${target}`,
        description: "Start the pod again (Runpod may need a free GPU on the same host).",
        destructive: false,
      },
    ];
  }

  switch (resource.resourceTypeId) {
    case "pod":
      return [
        {
          tool: "runpodctl",
          command: `runpodctl pod delete ${target}`,
          description:
            "Terminate the stopped pod and delete its pod volume. Copy anything you need off it first.",
          destructive: true,
        },
      ];
    case "network-volume":
      return [
        {
          tool: "runpodctl",
          command: `runpodctl network-volume delete ${target}`,
          description: "Delete the unused network volume and all of its data.",
          destructive: true,
        },
      ];
    default:
      return [];
  }
}

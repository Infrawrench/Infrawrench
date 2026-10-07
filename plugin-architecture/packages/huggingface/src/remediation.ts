import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `hf` (huggingface_hub CLI) commands for savings findings. The
 * plugin declares no orphan rule or right-sizing, so the only finding is a
 * sleep schedule over the three types with a `lifecycle`: Inference
 * Endpoints (pause / resume), Spaces (pause / restart) and scheduled Jobs
 * (suspend / resume). `hf` reads its token from `hf auth login` or `HF_TOKEN`.
 *
 * Reference: https://huggingface.co/docs/huggingface_hub/package_reference/cli
 */
export function huggingfaceRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const namespace = remediationField(resource, "namespace");
  const nsFlag = namespace ? ` --namespace ${shellQuote(namespace)}` : "";

  switch (resource.resourceTypeId) {
    case "hf-inference-endpoint": {
      // hf endpoints pause [OPTIONS] NAME / hf endpoints resume [OPTIONS] NAME
      const name = remediationId(resource, "name");
      if (!name) return [];
      return [
        {
          tool: "hf",
          command: `hf endpoints pause${nsFlag} ${shellQuote(name)}`,
          description:
            "Pause the Inference Endpoint; it stops billing and stays paused until resumed, unlike scale-to-zero.",
          destructive: false,
        },
        {
          tool: "hf",
          command: `hf endpoints resume${nsFlag} ${shellQuote(name)}`,
          description: "Resume the Inference Endpoint.",
          destructive: false,
        },
      ];
    }
    case "hf-space": {
      // hf spaces pause [OPTIONS] SPACE_ID / hf spaces restart [OPTIONS] SPACE_ID
      const repoId = remediationId(resource, "repoId");
      if (!repoId) return [];
      return [
        {
          tool: "hf",
          command: `hf spaces pause ${shellQuote(repoId)}`,
          description: "Pause the Space; paid hardware stops billing until the Space is restarted.",
          destructive: false,
        },
        {
          tool: "hf",
          command: `hf spaces restart ${shellQuote(repoId)}`,
          description: "Restart the Space on its configured hardware.",
          destructive: false,
        },
      ];
    }
    case "hf-scheduled-job": {
      // hf jobs scheduled suspend [OPTIONS] SCHEDULED_JOB_ID / ... resume
      const id = remediationId(resource, "scheduledJobId");
      if (!id) return [];
      return [
        {
          tool: "hf",
          command: `hf jobs scheduled suspend${nsFlag} ${shellQuote(id)}`,
          description: "Suspend the scheduled Job so no new runs start.",
          destructive: false,
        },
        {
          tool: "hf",
          command: `hf jobs scheduled resume${nsFlag} ${shellQuote(id)}`,
          description: "Resume the schedule.",
          destructive: false,
        },
      ];
    }
    default:
      return [];
  }
}

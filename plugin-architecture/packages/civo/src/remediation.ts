import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `civo` commands for savings findings. Every Civo resource is
 * regional, so each command carries `--region` from the stored
 * `{region}/{id}` external id, and deletes pass `-y` because the CLI prompts
 * otherwise.
 *
 * Civo bills a shut-off instance in full, so a sleep schedule saves nothing
 * there; the stop/start pair is still what the schedule runs, and the
 * description says so.
 *
 * The CLI's load balancer remove is disabled in the current release
 * (`loadbalancer_remove.go.disabled`), so that one is `curl` against the API
 * route civogo's `DeleteLoadBalancer` calls.
 *
 * References (verified 2026-10 against https://github.com/civo/cli/tree/master/cmd):
 * instance start|stop|remove, instance snapshot create --name, volume remove,
 * ip delete, root flags --region and -y/--yes;
 * https://github.com/civo/civogo/blob/master/loadbalancer.go (DELETE /v2/loadbalancers/:id, region query).
 */
export function civoRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const parts = (resource.externalId ?? "").trim().split("/");
  if (parts.length !== 2) return [];
  const [idRegion = "", id = ""] = parts;
  const region = remediationField(resource, "region") || idRegion;
  if (!region || !id) return [];
  const r = `--region ${shellQuote(region)}`;
  const q = shellQuote(id);

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "instance") return [];
    return [
      cmd(
        `civo instance stop ${q} ${r}`,
        "Stop the instance (Civo keeps billing a shut-off instance; only deleting it stops charges).",
      ),
      cmd(`civo instance start ${q} ${r}`, "Start the instance again."),
    ];
  }

  switch (resource.resourceTypeId) {
    case "instance":
      return [
        cmd(
          `civo instance snapshot create ${q} --name ${shellQuote(`infrawrench-${id}-${remediationDateStamp()}`)} ${r}`,
          "Snapshot the instance first so it can be restored later; wait for the snapshot to complete before deleting.",
        ),
        cmd(
          `civo instance remove ${q} ${r} -y`,
          "Delete the shut-off instance and its disk; billing stops.",
          true,
        ),
      ];
    case "volume":
      return [
        cmd(
          `civo volume remove ${q} ${r} -y`,
          "Delete the detached volume and all of its data.",
          true,
        ),
      ];
    case "reserved-ip":
      return [
        cmd(
          `civo ip delete ${q} ${r} -y`,
          "Release the unassigned reserved IP; the address cannot be got back.",
          true,
        ),
      ];
    case "load-balancer":
      return [
        {
          tool: "curl",
          command: `curl -sS -X DELETE ${shellQuote(`https://api.civo.com/v2/loadbalancers/${encodeURIComponent(id)}?region=${encodeURIComponent(region)}`)} -H "Authorization: bearer $CIVO_TOKEN"`,
          description: "Delete the load balancer with no backends; its public IP is released.",
          destructive: true,
          placeholders: [TOKEN],
        },
      ];
    default:
      return [];
  }
}

const TOKEN: RemediationPlaceholder = {
  name: "CIVO_TOKEN",
  description: "A Civo API key for this account",
};

function cmd(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "civo", command, description, destructive };
}

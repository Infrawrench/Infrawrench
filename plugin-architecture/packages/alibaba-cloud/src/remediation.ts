import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `aliyun` (Alibaba Cloud CLI) commands for savings findings,
 * the same RPC operations this plugin's own actions call. The CLI takes the
 * API name in PascalCase and each request parameter as `--Name value`;
 * `--RegionId` doubles as the CLI's region selector. Credentials come from
 * the active `aliyun configure` profile.
 *
 * Regional resources store `{region}/{id}` external ids.
 *
 * References:
 * https://github.com/aliyun/aliyun-cli (command syntax, region flag)
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-stopinstance
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-startinstance
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-modifyinstancespec
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-modifyprepayinstancespec
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-modifyinstanceautorenewattribute
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-createimage
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-deleteinstance
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-createsnapshot
 * https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-deletedisk
 * https://www.alibabacloud.com/help/en/vpc/developer-reference/api-vpc-2016-04-28-releaseeipaddress
 * https://www.alibabacloud.com/help/en/slb/classic-load-balancer/developer-reference/api-slb-2014-05-15-setloadbalancerstatus
 */
export function alibabaRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;
  const ref = regionalRef(resource);
  if (!ref) return [];
  const r = shellQuote(ref.region);
  const id = shellQuote(ref.id);
  const prepaid = remediationField(resource, "chargeType") === "PrePaid";

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "ecs-instance" || !finding.targetSize) return [];
    const target = shellQuote(finding.targetSize);
    const resize = prepaid
      ? aliyun(
          `aliyun ecs ModifyPrepayInstanceSpec --RegionId ${r} --InstanceId ${id} --InstanceType ${target} --AutoPay true`,
          `Change the subscription instance to ${finding.targetSize}; the price difference of a downgrade is refunded.`,
        )
      : aliyun(
          `aliyun ecs ModifyInstanceSpec --RegionId ${r} --InstanceId ${id} --InstanceType ${target}`,
          `Change the pay-as-you-go instance type to ${finding.targetSize}.`,
        );
    return [
      aliyun(
        `aliyun ecs StopInstance --RegionId ${r} --InstanceId ${id}`,
        "Stop the instance; a downgrade needs it stopped, which causes downtime.",
      ),
      resize,
      aliyun(
        `aliyun ecs StartInstance --RegionId ${r} --InstanceId ${id}`,
        "Start the instance again; ECS does not restart it on its own.",
      ),
    ];
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId === "ecs-instance") {
      return [
        aliyun(
          `aliyun ecs StopInstance --RegionId ${r} --InstanceId ${id}${prepaid ? "" : " --StoppedMode StopCharging"}`,
          prepaid
            ? "Stop the instance. A subscription instance is prepaid, so stopping it saves nothing on compute."
            : "Stop the instance in economical mode, which releases its vCPUs and memory from billing (disks keep billing).",
        ),
        aliyun(
          `aliyun ecs StartInstance --RegionId ${r} --InstanceId ${id}`,
          "Start the instance again.",
        ),
      ];
    }
    if (resource.resourceTypeId === "slb") {
      return [
        aliyun(
          `aliyun slb SetLoadBalancerStatus --RegionId ${r} --LoadBalancerId ${id} --LoadBalancerStatus inactive`,
          "Stop the load balancer forwarding traffic. Alibaba keeps billing a stopped CLB's instance fee until it is released.",
        ),
        aliyun(
          `aliyun slb SetLoadBalancerStatus --RegionId ${r} --LoadBalancerId ${id} --LoadBalancerStatus active`,
          "Start forwarding again.",
        ),
      ];
    }
    return [];
  }

  // orphan
  const stamp = remediationDateStamp();
  switch (resource.resourceTypeId) {
    case "ecs-instance":
      if (prepaid) {
        return [
          aliyun(
            `aliyun ecs ModifyInstanceAutoRenewAttribute --RegionId ${r} --InstanceId ${id} --RenewalStatus NotRenewal`,
            "Turn off renewal so the subscription instance is released when its term ends; a prepaid instance cannot be deleted before then from the CLI.",
          ),
        ];
      }
      return [
        aliyun(
          `aliyun ecs CreateImage --RegionId ${r} --InstanceId ${id} --ImageName ${shellQuote(`iw-${ref.id}-${stamp}`)}`,
          "Create a custom image of the instance (all its disks) so it can be recreated later.",
        ),
        aliyun(
          `aliyun ecs DeleteInstance --RegionId ${r} --InstanceId ${id} --Force true`,
          "Delete the stopped instance; disks set to delete with it go too.",
          true,
        ),
      ];
    case "disk":
      return [
        aliyun(
          `aliyun ecs CreateSnapshot --RegionId ${r} --DiskId ${id} --SnapshotName ${shellQuote(`iw-${ref.id}-${stamp}`)}`,
          "Snapshot the disk before deleting it.",
        ),
        aliyun(
          `aliyun ecs DeleteDisk --RegionId ${r} --DiskId ${id}`,
          "Delete the unattached disk and all of its data.",
          true,
        ),
      ];
    case "eip":
      if (prepaid) return [];
      return [
        aliyun(
          `aliyun vpc ReleaseEipAddress --RegionId ${r} --AllocationId ${id}`,
          "Release the unassociated Elastic IP; the address cannot be got back.",
          true,
        ),
      ];
    default:
      return [];
  }
}

/** `{region}/{id}` from the external id, the region falling back to the stored field. */
function regionalRef(resource: RemediationResource): { region: string; id: string } | null {
  const ext = (resource.externalId ?? "").trim();
  const slash = ext.indexOf("/");
  const id = slash >= 0 ? ext.slice(slash + 1) : ext;
  const region = (slash >= 0 ? ext.slice(0, slash) : "") || remediationField(resource, "region");
  if (!id || !region || id.includes("/")) return null;
  return { region, id };
}

function aliyun(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "aliyun", command, description, destructive };
}

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { ensureArray } from "./auth.js";
import { ec2Call } from "./client-transport.js";

interface AttachContext {
  /** Home/default creds — used only for global services. */
  creds: AwsCredentials;
  /** Build creds scoped to a specific region — use this for regional services. */
  credsFor(region: string): AwsCredentials;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}

export async function attachResource(
  ctx: AttachContext,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
  accountId: string,
): Promise<void> {
  if (sourceTypeId === "elastic-ip" && targetTypeId === "ec2-instance") {
    const [ipResource, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const allocationId = String(
      ipResource.fields["allocationId"] ?? ipResource.resolvedOutputs["allocationId"] ?? "",
    );
    const instanceId = String(
      instance.fields["instanceId"] ?? instance.resolvedOutputs["instanceId"] ?? "",
    );
    if (!allocationId || !instanceId) {
      throw new Error("Cannot determine AllocationId or InstanceId for attachment");
    }
    const region = String(instance.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    // Associate the Elastic IP with the EC2 instance
    await ec2Call<unknown>(creds, "AssociateAddress", {
      AllocationId: allocationId,
      InstanceId: instanceId,
    });
    return;
  }
  if (sourceTypeId === "ebs-volume" && targetTypeId === "ec2-instance") {
    const [volume, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const volumeId = String(volume.fields["volumeId"] ?? volume.externalId ?? "");
    const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
    const volumeAz = String(volume.fields["availabilityZone"] ?? "");
    const instanceAz = String(instance.fields["availabilityZone"] ?? "");
    if (!volumeId || !instanceId) {
      throw new Error("Cannot determine VolumeId or InstanceId for attachment");
    }
    if (volumeAz && instanceAz && volumeAz !== instanceAz) {
      throw new Error(
        `Volume AZ ${volumeAz} does not match instance AZ ${instanceAz} — EBS volumes must be in the same AZ as the instance.`,
      );
    }
    const region = String(instance.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    // Pick the first free device letter after /dev/sdf (sdf..sdp is the conventional range)
    const device = "/dev/sdf";
    await ec2Call(creds, "AttachVolume", {
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: device,
    });
    return;
  }
  if (sourceTypeId === "security-group" && targetTypeId === "ec2-instance") {
    const [sg, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const sgId = String(sg.fields["groupId"] ?? sg.externalId ?? "");
    const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
    if (!sgId || !instanceId) {
      throw new Error("Cannot determine security group or instance id for attachment");
    }
    const region = String(instance.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    // Fetch the instance's current SG IDs so we don't overwrite existing ones.
    const describeRes = await ec2Call<Record<string, unknown>>(creds, "DescribeInstances", {
      "InstanceId.1": instanceId,
    });
    const reservations = ensureArray(
      (describeRes["reservationSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const inst = ensureArray(
      (reservations[0]?.["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
    )[0] as Record<string, unknown> | undefined;
    const currentGroups = ensureArray(
      (inst?.["groupSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const current = currentGroups.map((g) => String(g["groupId"] ?? "")).filter(Boolean);
    if (current.includes(sgId)) return;
    const next = [...current, sgId];
    const params: Record<string, string> = { InstanceId: instanceId };
    next.forEach((g, i) => {
      params[`GroupId.${i + 1}`] = g;
    });
    await ec2Call(creds, "ModifyInstanceAttribute", params);
    return;
  }
  throw new Error(`AWS plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`);
}

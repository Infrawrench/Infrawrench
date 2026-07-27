/** Detail views for DigitalOcean block volumes, snapshots, images and NFS shares. */
import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";

export function applyVolumeDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const dropletIds = String(fields["dropletIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const isAttached = dropletIds.length > 0;
  const headerActions: DetailViewSchema["headerActions"] = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: "Take Snapshot\u2026",
      action: {
        type: "prompt-nosql-command",
        command: "volume-snapshot",
        title: "Snapshot volume",
        description:
          "Captures a point-in-time copy of this volume. Snapshots inherit the volume's region but can be used to create volumes in any DO region.",
        fields: [
          {
            key: "name",
            label: "Snapshot Name",
            kind: "text",
            required: true,
            defaultValue: `${String(fields["name"] ?? "vol")}-${new Date().toISOString().slice(0, 10)}`,
          },
        ],
        submitLabel: "Snapshot",
      },
    },
    {
      kind: "action",
      label: "Resize\u2026",
      action: {
        type: "prompt-nosql-command",
        command: "volume-resize",
        title: "Resize volume",
        description:
          "Block storage volumes can only grow \u2014 DigitalOcean does not support shrinking. The filesystem may need a manual `resize2fs` / `xfs_growfs` call after.",
        fields: [
          {
            key: "sizeGb",
            label: "New Size (GiB)",
            kind: "number",
            required: true,
            defaultValue: String(fields["sizeGb"] ?? "100"),
            description: "Must be greater than the current size.",
          },
        ],
        submitLabel: "Resize",
      },
    },
  ];
  if (isAttached) {
    headerActions.push({
      kind: "action",
      label: "Detach",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "detach",
        confirmMessage: `Detach this volume from droplet ${dropletIds[0]}? Make sure the filesystem is unmounted first.`,
        successMessage: "Detach queued.",
      },
    });
  }
  detail.headerActions = headerActions;
}

export function applySnapshotDetail(detail: DetailViewSchema, _resource: ResourceInstance): void {
  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];
}

export function applyImageDetail(detail: DetailViewSchema, _resource: ResourceInstance): void {
  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];
}

export function applyNfsShareDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const mountTarget = String(
    resource.resolvedOutputs["mountTarget"] ?? fields["mountTarget"] ?? "",
  );
  const mountCmd = String(resource.resolvedOutputs["mountCommand"] ?? "");
  if (mountTarget || mountCmd) {
    detail.sections.push({
      kind: "section",
      title: "Mount",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "NFS Server", value: mountTarget, copyable: true },
            ...(mountCmd ? [{ key: "Mount Command", value: mountCmd, copyable: true }] : []),
          ],
        },
        {
          kind: "text",
          variant: "muted",
          content:
            "The mount target is only reachable from droplets and DOKS nodes in a VPC listed on this share. NFSv4.1 only.",
        },
      ],
    });
  }
}

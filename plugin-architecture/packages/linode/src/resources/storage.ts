import { f, o, rt } from "@infrawrench/plugin-base";
import { REGION_IDS } from "../regions.js";

/** Block Storage volume. `externalId` is the numeric volume id. */
export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Linode Block Storage volume",
  fields: [
    f("label", "Label"),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "Volumes can grow (10 to 16,384 GB) but never shrink",
    }),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("linodeId", "Attached Linode", {
      required: false,
      editable: false,
      description: "ID of the Linode this volume is attached to; empty when detached",
    }),
    f("linodeLabel", "Attached Linode Label", { required: false, editable: false }),
    f("filesystemPath", "Filesystem Path", { required: false, editable: false }),
    f("hardwareType", "Hardware", { required: false, editable: false }),
    f("encryption", "Encryption", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [o("filesystemPath", "Filesystem Path")],
  dependsOn: [{ fieldKey: "linodeId", targetTypeId: "linode", label: "attached to" }],
  iconKey: "volume",
  supportsCreate: true,
  // Edit = label, tags and grow (`/volumes/{id}/resize`).
  supportsUpdate: true,
  // The lister always writes `linodeId` ("" when detached).
  orphanRule: {
    conditions: [{ fieldKey: "linodeId", when: "equals", value: "" }],
    reason: "Volume is not attached to any Linode but is still billed per GB",
  },
  attachTargets: [
    { pluginId: "linode", resourceTypeId: "linode", matchField: "region", verb: "Attach" },
  ],
  postureChecks: [
    {
      id: "linode-volume-unencrypted",
      title: "Volume not encrypted",
      severity: "low",
      category: "encryption",
      conditions: [{ fieldKey: "encryption", when: "equals", value: "disabled" }],
      reason: "Block Storage encryption is off for this volume.",
    },
  ],
});

/**
 * Object Storage bucket. `externalId` is `{region}/{name}`: every bucket
 * endpoint is addressed by both.
 */
export const BucketResourceType = rt({
  name: "Bucket",
  id: "bucket",
  description: "A Linode Object Storage bucket",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("hostname", "Hostname", { required: false, editable: false }),
    f("s3Endpoint", "S3 Endpoint", { required: false, editable: false }),
    f("endpointType", "Endpoint Type", { required: false, editable: false }),
    f("objects", "Objects", { kind: "number", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("acl", "Access", {
      kind: "enum",
      required: false,
      enumValues: ["private", "public-read", "authenticated-read", "public-read-write"],
      description: "Canned ACL applied to the bucket",
    }),
    f("corsEnabled", "CORS", { kind: "boolean", required: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("hostname", "Hostname"), o("s3Endpoint", "S3 Endpoint")],
  iconKey: "storage",
  supportsCreate: true,
  // Edit = ACL and CORS (`PUT /object-storage/buckets/{region}/{bucket}/access`).
  supportsUpdate: true,
  supportsStorageBrowser: true,
  postureChecks: [
    {
      id: "linode-bucket-public",
      title: "Bucket is publicly readable",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "acl", when: "equals", value: "public-read" }],
      reason: "Anyone on the internet can list and read this bucket's objects.",
    },
    {
      id: "linode-bucket-public-write",
      title: "Bucket is publicly writable",
      severity: "critical",
      category: "public-exposure",
      conditions: [{ fieldKey: "acl", when: "equals", value: "public-read-write" }],
      reason: "Anyone on the internet can write to this bucket.",
    },
  ],
  // `{bucket}.{cluster}.linodeobjects.com` (E0/E1) and
  // `{bucket}.{region}-1.linodeobjects.com` (E2/E3): the first label is the
  // bucket name either way.
  dnsServiceHosts: [
    {
      id: "linode-object-storage",
      label: "Linode Object Storage bucket",
      hostPattern: "([a-z0-9][a-z0-9.-]*?)\\.[a-z0-9-]+\\.linodeobjects\\.com",
      labelIs: "name",
      reason:
        "The record points at a Linode Object Storage bucket name that no synced bucket owns; anyone can create a bucket with that name and serve content from your domain.",
    },
  ],
});

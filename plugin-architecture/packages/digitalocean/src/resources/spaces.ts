import { f, o, rt } from "@infrawrench/plugin-base";

export const SpacesResourceType = rt({
  name: "Spaces Bucket",
  id: "spaces-bucket",
  description: "A DigitalOcean Spaces object storage bucket",
  fields: [
    f("name", "Bucket Name"),
    f("region", "Region", {
      kind: "enum",
      enumValues: ["nyc3", "sfo3", "ams3", "fra1", "sgp1", "syd1"],
    }),
    f("accessControl", "Access Control", { kind: "enum", enumValues: ["private", "public-read"] }),
  ],
  outputs: [
    o("endpoint", "Endpoint URL"),
    o("accessKeyId", "Access Key ID", { sensitive: true }),
    o("secretAccessKey", "Secret Access Key", { sensitive: true }),
  ],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  supportsStorageBrowser: true,
  iconKey: "spaces",
  // `bucket.nyc3.digitaloceanspaces.com`, plus the CDN form
  // `bucket.nyc3.cdn.digitaloceanspaces.com`.
  dnsServiceHosts: [
    {
      id: "spaces-endpoint",
      label: "Spaces bucket endpoint",
      // Bucket names are letters/numbers/dashes only — periods are not
      // allowed, so a dotted label cannot be a Spaces endpoint.
      hostPattern: String.raw`([a-z0-9][a-z0-9-]*)\.[a-z0-9]+\.(?:cdn\.)?digitaloceanspaces\.com`,
      reason:
        "Spaces bucket names are unique per region and released on delete, so another DigitalOcean customer can recreate the bucket and serve their objects from your hostname.",
    },
  ],
  credentialFormats: [
    {
      id: "bucket-scoped-rw",
      label: "Scoped Access Key (read/write)",
      description:
        "Creates a new Spaces key restricted to this bucket only, with readwrite permission.",
      mediaType: "ini",
      filenameTemplate: "{resource}.credentials",
    },
    {
      id: "bucket-scoped-ro",
      label: "Scoped Access Key (read-only)",
      description: "Creates a new Spaces key restricted to this bucket only, with read permission.",
      mediaType: "ini",
      filenameTemplate: "{resource}.credentials",
    },
  ],
  secretExportTemplates: [
    {
      id: "s3-compatible",
      displayName: "S3-Compatible Credentials",
      description: "AWS-style environment variables for S3-compatible access",
      entries: [
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "accessKeyId" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "secretAccessKey" },
        {
          envKey: "AWS_ENDPOINT_URL",
          outputKey: "endpoint",
          description: "S3-compatible endpoint URL",
        },
      ],
    },
  ],
});

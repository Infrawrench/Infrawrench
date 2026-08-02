import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An UploadThing app.
 *
 * There is exactly one per account: an UploadThing API key is app-scoped and
 * every REST endpoint is implicitly scoped to the app the key belongs to, so
 * there is no "list apps" call and no way for one account to see two apps.
 * The type still exists as a resource because it is the thing that carries the
 * storage quota, the ACL policy, and the file browser.
 */
export const UtAppResourceType = rt({
  name: "App",
  id: "ut-app",
  description: "An UploadThing app — the storage namespace an API key belongs to",
  fields: [
    f("appId", "App ID"),
    f("defaultAcl", "Default ACL", {
      kind: "enum",
      required: false,
      enumValues: ["public-read", "private"],
    }),
    f("allowAclOverride", "Per-file ACL Overrides", { kind: "boolean", required: false }),
    f("region", "Region", { required: false }),
    f("filesUploaded", "Files Uploaded", { kind: "number", required: false }),
    f("appTotalBytes", "Storage Used", { kind: "number", required: false }),
    f("totalBytes", "Storage Counted Against Quota", { kind: "number", required: false }),
    f("limitBytes", "Storage Quota", { kind: "number", required: false }),
  ],
  outputs: [
    o("appId", "App ID"),
    o("appUrl", "App URL", { description: "https://<appId>.ufs.sh — the app's file-serving host" }),
    o("fileUrlPrefix", "File URL Prefix", {
      description: "Prepend to a file key to get its public URL",
    }),
  ],
  supportsStorageBrowser: true,
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "app",
});

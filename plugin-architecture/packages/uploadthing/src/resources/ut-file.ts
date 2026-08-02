import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file stored in UploadThing.
 *
 * `name` is the only editable field — `POST /v6/renameFiles` is the sole
 * mutation the API offers over an existing file's metadata. The key, size and
 * upload time are assigned at upload and never change, and the ACL is moved by
 * its own action rather than the edit form (it is a separate endpoint, and it
 * only works when the app allows per-file overrides).
 */
export const UtFileResourceType = rt({
  name: "File",
  id: "ut-file",
  pinnable: false,
  description: "A file uploaded to UploadThing",
  fields: [
    f("key", "File Key", { editable: false }),
    f("name", "Name"),
    f("size", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("sizeLabel", "Size", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["Uploaded", "Uploading", "Failed", "Deletion Pending"],
      editable: false,
    }),
    f("customId", "Custom ID", { required: false, editable: false }),
    f("contentType", "Content Type", { required: false, editable: false }),
    f("uploadedAt", "Uploaded At", { required: false, editable: false }),
    f("ufsUrl", "URL", { required: false, editable: false }),
    // Stamped from the app's settings so the detail view knows whether to offer
    // the ACL actions without the file rows having to fetch app info themselves.
    f("aclOverrideAllowed", "ACL Overrides Allowed", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("appDefaultAcl", "App Default ACL", { required: false, editable: false }),
  ],
  outputs: [
    o("fileKey", "File Key"),
    o("ufsUrl", "File URL", {
      description: "Public URL. Only resolves for files whose ACL is public-read.",
    }),
    o("signedUrl", "Signed URL", {
      sensitive: true,
      description:
        "Short-lived presigned GET URL, minted on demand. This is how a private file is read.",
    }),
  ],
  parentTypeId: "ut-app",
  // Deliberately sidebar-hidden. There is exactly one app per account, so the
  // app page *is* the account page and its Files tab is always right there,
  // browsing the name paths as folders. A sidebar section would instead be one
  // flat run of every file in the app — and the listing is uncapped, so an
  // archive upload alone would drown out every other account.
  // (The account page still lists this type; `getVisibleAccountCategories`
  // does not read this flag.)
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "Failed" }],
    reason: "Upload never completed — this file cannot be served and can be deleted.",
  },
  iconKey: "file",
});

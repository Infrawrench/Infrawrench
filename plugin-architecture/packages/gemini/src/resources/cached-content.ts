import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A context cache — a pre-tokenised prompt prefix that later requests can
 * reference by name, billed at a reduced rate for the cached tokens.
 *
 * Verified: https://ai.google.dev/api/caching#method:-cachedcontents.list
 * `GET /v1beta/cachedContents?pageSize=&pageToken=` →
 * `{ cachedContents: [...], nextPageToken }`.
 */
export const CachedContentResourceType = rt({
  name: "Cached Content",
  id: "cached-content",
  plural: "Cached Contents",
  description: "A reusable cached prompt prefix billed at the reduced context-cache rate",
  fields: [
    f("name", "Resource Name"),
    f("displayName", "Display Name", { required: false }),
    f("model", "Model", { required: false }),
    f("totalTokenCount", "Cached Tokens", { kind: "number", required: false }),
    f("ttl", "TTL", { required: false }),
    f("expireTime", "Expires", { required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
  ],
  outputs: [
    o("cachedContentName", "Cached Content Name", {
      description:
        'Pass as `cachedContent` on a generateContent request, e.g. "cachedContents/abc123"',
    }),
    o("model", "Model"),
    o("totalTokenCount", "Cached Tokens"),
  ],
  // `model` is a full `models/{model}` name, matching the Model row's `name`.
  dependsOn: [{ fieldKey: "model", targetTypeId: "model", targetKey: "name", label: "caches" }],
  // TTL is the one thing the API lets you change after creation
  // (PATCH with updateMask=ttl).
  supportsUpdate: true,
  iconKey: "cache",
});

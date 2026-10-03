import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A document library: a searchable collection of uploaded documents that
 * agents use through a `document_library` tool.
 *
 * `GET /v1/libraries` (cursor-paged with `page_token`; the offset `page`
 * parameter is deprecated). Create is `POST /v1/libraries`, rename and
 * re-describe with `PATCH /v1/libraries/{library_id}`, delete with
 * `DELETE /v1/libraries/{library_id}`.
 * https://docs.mistral.ai/openapi.yaml
 */
export const MistralLibraryResourceType = rt({
  name: "Library",
  plural: "Libraries",
  id: "mistral-library",
  description:
    "A Mistral document library that agents search through a document_library tool. Create, rename and delete.",
  fields: [
    f("libraryId", "Library ID", { editable: false }),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("documents", "Documents", { kind: "number", required: false, editable: false }),
    f("totalSize", "Total Size (bytes)", { kind: "number", required: false, editable: false }),
    f("ownerType", "Owner", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("libraryId", "Library ID", {
      description: "Pass in `library_ids` on a document_library tool",
    }),
    o("name", "Library Name"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

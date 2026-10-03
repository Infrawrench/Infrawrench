import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Cartesia pronunciation dictionary: a named set of text → pronunciation
 * substitutions applied at synthesis time.
 * Source: GET https://api.cartesia.ai/pronunciation-dicts/ ; created with
 * `POST /pronunciation-dicts/` and edited with `PATCH /pronunciation-dicts/{id}`.
 * https://docs.cartesia.ai/api-reference/pronunciation-dicts/list
 * https://docs.cartesia.ai/api-reference/pronunciation-dicts/create
 * https://docs.cartesia.ai/api-reference/pronunciation-dicts/update
 */
export const PronunciationDictResourceType = rt({
  name: "Pronunciation Dictionary",
  plural: "Pronunciation Dictionaries",
  id: "pronunciation-dict",
  description:
    "A set of text-to-pronunciation overrides Cartesia applies while synthesizing — brand names, acronyms, and proper nouns the model would otherwise mispronounce",
  fields: [
    f("name", "Name"),
    f("dictId", "Dictionary ID", { editable: false }),
    f("description", "Description", { required: false }),
    f("entries", "Entries", {
      required: false,
      description: "Entries as text = pronunciation, separated by semicolons",
    }),
    f("entryCount", "Entry Count", { kind: "number", required: false, editable: false }),
    f("accessType", "Access", { kind: "enum", required: false, enumValues: ["private", "public"] }),
    f("visibility", "Visibility", { required: false, editable: false }),
    f("isOwner", "Owned by You", { kind: "boolean", required: false, editable: false }),
    f("pinned", "Pinned", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("dictId", "Dictionary ID", {
      description: "Pass as pronunciation_dict_id on sonic-3 and newer",
    }),
    o("dictName", "Dictionary Name"),
  ],
  iconKey: "dictionary",
  supportsCreate: true,
  supportsUpdate: true,
});

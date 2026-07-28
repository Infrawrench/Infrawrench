import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Cartesia pronunciation dictionary — a named set of text → pronunciation
 * substitutions applied at synthesis time.
 * Source: GET https://api.cartesia.ai/pronunciation-dicts/
 * https://docs.cartesia.ai/api-reference/pronunciation-dicts/list
 */
export const PronunciationDictResourceType = rt({
  name: "Pronunciation Dictionary",
  plural: "Pronunciation Dictionaries",
  id: "pronunciation-dict",
  description:
    "A set of text-to-pronunciation overrides Cartesia applies while synthesizing — brand names, acronyms, and proper nouns the model would otherwise mispronounce",
  fields: [
    f("name", "Name"),
    f("dictId", "Dictionary ID"),
    f("description", "Description", { required: false }),
    f("entryCount", "Entries", { kind: "number", required: false }),
    f("accessType", "Access", { required: false }),
    f("visibility", "Visibility", { required: false }),
    f("isOwner", "Owned by You", { kind: "boolean", required: false }),
    f("pinned", "Pinned", { kind: "boolean", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("dictId", "Dictionary ID"), o("dictName", "Dictionary Name")],
  iconKey: "dictionary",
});

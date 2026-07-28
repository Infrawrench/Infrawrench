import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A pronunciation dictionary — a set of phoneme/alias rules applied at
 * synthesis time. Listed from `GET /v1/pronunciation-dictionaries`.
 * https://elevenlabs.io/docs/api-reference/pronunciation-dictionaries/list
 */
export const PronunciationDictionaryResourceType = rt({
  name: "Pronunciation Dictionary",
  plural: "Pronunciation Dictionaries",
  id: "pronunciation-dictionary",
  description: "A set of pronunciation rules applied when synthesising speech",
  fields: [
    f("name", "Name"),
    f("dictionaryId", "Dictionary ID"),
    f("latestVersionId", "Latest Version ID", { required: false }),
    f("description", "Description", { required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("ruleCount", "Rules", { kind: "number", required: false }),
  ],
  outputs: [
    o("dictionaryId", "Dictionary ID"),
    o("latestVersionId", "Latest Version ID", {
      description: "Pass alongside the dictionary id in pronunciation_dictionary_locators",
    }),
  ],
  iconKey: "dictionary",
  supportsDelete: false,
});

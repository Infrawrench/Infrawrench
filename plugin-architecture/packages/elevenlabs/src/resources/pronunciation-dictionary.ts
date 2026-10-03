import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A pronunciation dictionary: a set of phoneme/alias rules applied at
 * synthesis time. Listed from `GET /v1/pronunciation-dictionaries`, created
 * with `POST /v1/pronunciation-dictionaries/add-from-rules` and renamed or
 * archived with `PATCH /v1/pronunciation-dictionaries/{id}`. ElevenLabs has no
 * hard delete: deleting here archives the dictionary.
 * https://elevenlabs.io/docs/api-reference/pronunciation-dictionaries/list
 * https://elevenlabs.io/docs/api-reference/pronunciation-dictionaries/create-from-rules
 * https://elevenlabs.io/docs/api-reference/pronunciation-dictionaries/update
 */
export const PronunciationDictionaryResourceType = rt({
  name: "Pronunciation Dictionary",
  plural: "Pronunciation Dictionaries",
  id: "pronunciation-dictionary",
  description: "A set of pronunciation rules applied when synthesising speech",
  fields: [
    f("name", "Name"),
    f("dictionaryId", "Dictionary ID", { editable: false }),
    f("latestVersionId", "Latest Version ID", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("permission", "Your Permission", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
  ],
  outputs: [
    o("dictionaryId", "Dictionary ID"),
    o("latestVersionId", "Latest Version ID", {
      description: "Pass alongside the dictionary id in pronunciation_dictionary_locators",
    }),
  ],
  iconKey: "dictionary",
  supportsCreate: true,
  supportsUpdate: true,
});

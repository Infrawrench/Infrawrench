import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A custom vocabulary — a saved phrase list a job can reference by
 * `custom_vocabulary_id`.
 *
 * Note the status enum uses `complete`, not `completed`. Custom vocabularies
 * are a **US-deployment-only** surface: the EU deployment accepts phrases
 * inline at submit time but has no `/vocabularies` collection.
 */
export const VocabularyResourceType = rt({
  name: "Custom Vocabulary",
  plural: "Custom Vocabularies",
  id: "vocabulary",
  description: "A saved Rev AI phrase list that jobs can reference by id",
  fields: [
    f("status", "Status", {
      kind: "enum",
      enumValues: ["in_progress", "complete", "failed"],
    }),
    f("metadata", "Metadata", { required: false }),
    f("createdOn", "Created", { required: false }),
    f("completedOn", "Completed", { required: false }),
    f("failure", "Failure", { required: false }),
    f("failureDetail", "Failure Detail", { required: false }),
    f("callbackUrl", "Callback URL", { required: false }),
  ],
  outputs: [
    o("vocabularyId", "Vocabulary ID", {
      description: "Pass as `custom_vocabulary_id` when submitting a job",
    }),
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "vocabulary",
});

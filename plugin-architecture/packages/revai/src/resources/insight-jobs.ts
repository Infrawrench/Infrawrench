import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Rev AI's companion job APIs (language identification, sentiment analysis,
 * topic extraction and forced alignment). Each is its own collection with its
 * own 30-day listing, so each is its own type; the shared columns come first.
 * See `../insights.ts` for the verified routes.
 */
const statusField = f("status", "Status", {
  kind: "enum",
  enumValues: ["in_progress", "completed", "failed"],
  description: "Job state. Note `completed`, not the transcription API's `transcribed`.",
});

const commonFields = [
  f("createdOn", "Created", { required: false }),
  f("completedOn", "Completed", { required: false }),
  f("metadata", "Metadata", { required: false }),
  f("failure", "Failure", { required: false }),
  f("failureDetail", "Failure Detail", { required: false }),
  f("deleteAfterSeconds", "Auto-delete After (s)", { kind: "number", required: false }),
];

export const LanguageIdJobResourceType = rt({
  name: "Language Identification Job",
  plural: "Language Identification Jobs",
  id: "language-id-job",
  description:
    "A Rev AI job that identifies the most probable spoken language in a piece of media, from the last 30 days",
  fields: [
    statusField,
    f("topLanguage", "Top Language", { required: false }),
    f("topConfidence", "Confidence", { kind: "number", required: false }),
    f("processedDurationSeconds", "Processed (s)", { kind: "number", required: false }),
    f("mediaUrl", "Media URL", { required: false }),
    ...commonFields,
  ],
  outputs: [
    o("jobId", "Job ID"),
    o("topLanguage", "Top Language", {
      description: "ISO 639 code of the most probable language, empty until completed",
    }),
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "job",
});

export const SentimentJobResourceType = rt({
  name: "Sentiment Analysis Job",
  plural: "Sentiment Analysis Jobs",
  id: "sentiment-job",
  description:
    "A Rev AI job that scores each statement of an English transcript as positive, negative or neutral, from the last 30 days. US deployment only.",
  fields: [
    statusField,
    f("language", "Language", { required: false }),
    f("wordCount", "Words", { kind: "number", required: false }),
    f("positive", "Positive Statements", { kind: "number", required: false }),
    f("negative", "Negative Statements", { kind: "number", required: false }),
    f("neutral", "Neutral Statements", { kind: "number", required: false }),
    ...commonFields,
  ],
  outputs: [o("jobId", "Job ID")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "job",
});

export const TopicJobResourceType = rt({
  name: "Topic Extraction Job",
  plural: "Topic Extraction Jobs",
  id: "topic-job",
  description:
    "A Rev AI job that extracts the main topics of an English transcript, with a score and the statements behind each, from the last 30 days. US deployment only.",
  fields: [
    statusField,
    f("language", "Language", { required: false }),
    f("wordCount", "Words", { kind: "number", required: false }),
    f("topicCount", "Topics", { kind: "number", required: false }),
    f("topTopics", "Top Topics", { required: false }),
    ...commonFields,
  ],
  outputs: [o("jobId", "Job ID"), o("topTopics", "Top Topics")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "job",
});

export const AlignmentJobResourceType = rt({
  name: "Forced Alignment Job",
  plural: "Forced Alignment Jobs",
  id: "alignment-job",
  description:
    "A Rev AI job that aligns a known transcript to its media for precise word timings, from the last 30 days. US deployment only.",
  fields: [
    statusField,
    f("language", "Language", { required: false }),
    f("processedDurationSeconds", "Processed (s)", { kind: "number", required: false }),
    f("mediaUrl", "Media URL", { required: false }),
    ...commonFields,
  ],
  outputs: [o("jobId", "Job ID")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "job",
});

/**
 * Rev AI's four companion job APIs, verified 2026-10-03 against the OpenAPI
 * bundles behind https://docs.rev.ai/api/language-identification/reference,
 * .../sentiment-analysis/reference, .../topic-extraction/reference and
 * .../alignment/reference.
 *
 * They share one shape: `POST {prefix}/jobs`, `GET {prefix}/jobs` (a bare
 * array, newest first, last 30 days, paged by `starting_after`),
 * `GET`/`DELETE {prefix}/jobs/{id}`, and a result route. Each lives on the
 * deployment's root host (`https://api.rev.ai`, `https://ec1.api.rev.ai`)
 * rather than under `/speechtotext/v1`, and only Language Identification is
 * offered on the EU deployment
 * (https://docs.rev.ai/api/global-deployments).
 */

export type InsightTypeId = "language-id-job" | "sentiment-job" | "topic-job" | "alignment-job";

export interface InsightApi {
  typeId: InsightTypeId;
  /** Path prefix on the deployment's root host, e.g. `/languageid/v1`. */
  prefix: string;
  /** Short noun used in subtitles and errors. */
  label: string;
  /** `false` when the EU deployment serves this API too. */
  usOnly: boolean;
  /** Result route under `/jobs/{id}/`. */
  resultPath: "result" | "transcript";
  /** Accept header the result route answers to. */
  resultAccept: string;
}

export const INSIGHT_APIS: Record<InsightTypeId, InsightApi> = {
  "language-id-job": {
    typeId: "language-id-job",
    prefix: "/languageid/v1",
    label: "language identification job",
    usOnly: false,
    resultPath: "result",
    resultAccept: "application/json",
  },
  "sentiment-job": {
    typeId: "sentiment-job",
    prefix: "/sentiment_analysis/v1",
    label: "sentiment analysis job",
    usOnly: true,
    resultPath: "result",
    resultAccept: "application/vnd.rev.sentiment.v1.0+json",
  },
  "topic-job": {
    typeId: "topic-job",
    prefix: "/topic_extraction/v1",
    label: "topic extraction job",
    usOnly: true,
    resultPath: "result",
    resultAccept: "application/vnd.rev.topic.v1.0+json",
  },
  "alignment-job": {
    typeId: "alignment-job",
    prefix: "/alignment/v1",
    label: "forced alignment job",
    usOnly: true,
    resultPath: "transcript",
    resultAccept: "application/vnd.rev.transcript.v1.0+json",
  },
};

export function isInsightType(typeId: string): typeId is InsightTypeId {
  return typeId in INSIGHT_APIS;
}

/**
 * Union of the four job models. Every property is optional because Rev AI
 * omits null properties from responses entirely.
 */
export interface RevAiInsightJob {
  id?: string;
  /** `in_progress | completed | failed`: note `completed`, not `transcribed`. */
  status?: string;
  type?: string;
  created_on?: string;
  completed_on?: string;
  metadata?: string;
  failure?: string;
  failure_detail?: string;
  callback_url?: string;
  delete_after_seconds?: number;
  media_url?: string;
  language?: string;
  word_count?: number;
  processed_duration_seconds?: number;
}

/** `LanguageIdentificationResult`. */
export interface LanguageIdResult {
  top_language?: string;
  language_confidences?: Array<{ language?: string; confidence?: number }>;
}

/** `SentimentAnalysisResult`: `ts`/`end_ts` only when a transcript was submitted. */
export interface SentimentResult {
  messages?: Array<{
    content?: string;
    score?: number;
    sentiment?: string;
    ts?: number;
    end_ts?: number;
  }>;
}

/** `TopicExtractionResult`. */
export interface TopicResult {
  topics?: Array<{
    topic_name?: string;
    score?: number;
    informants?: Array<{ content?: string; ts?: number; end_ts?: number }>;
  }>;
}

/** Forced-alignment languages (`SubmitAlignmentJobOptions.language`). */
export const ALIGNMENT_LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
];

export function insightStatusDot(status: string): "healthy" | "error" | "provisioning" | "info" {
  if (status === "completed") return "healthy";
  if (status === "failed") return "error";
  if (status === "in_progress") return "provisioning";
  return "info";
}

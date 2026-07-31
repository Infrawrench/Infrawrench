/**
 * The optional AI-written paragraph that sits above the deterministic digest.
 *
 * Three properties this module exists to guarantee:
 *
 *   1. **Strictly additive.** It takes the already-composed `WeeklyDigest` and
 *      returns a paragraph or `null`. Every failure path — unconfigured, HTTP
 *      error, timeout, empty completion, refusal — returns `null`, and the
 *      digest goes out with its deterministic content intact. There is no code
 *      path here that can prevent a digest from sending.
 *   2. **The composer stays pure and LLM-free.** `compose.ts` never imports
 *      this; `weekly.ts` calls it between composing and delivering, and threads
 *      the result back in as an opaque string.
 *   3. **Only composed data leaves the building.** The prompt carries the
 *      digest object and nothing else: currency totals, week-over-week deltas,
 *      provider and service *names* with their spend, and three counts. No
 *      resource rows, no account metadata, no credentials, no free text an
 *      operator typed. `digestPromptPayload` is the allowlist, written out
 *      field by field so a later addition to `WeeklyDigest` cannot widen it by
 *      accident.
 *
 * Opt-in per org (`org_digest_settings.narrative_enabled`, default off), so no
 * org starts paying for — or sending data to — an LLM without asking.
 *
 * Config (env): ANTHROPIC_API_KEY. Shared with the chat feature; without it
 * this is a no-op with a log line and the digest simply loses the paragraph.
 */
import Anthropic from "@anthropic-ai/sdk";

import type { WeeklyDigest } from "./compose";
import { formatAmount } from "./compose";

/**
 * Anthropic's current frontier model. The digest is one short paragraph a week
 * per org, so the cost is negligible ($5/MTok in, $25/MTok out — this request
 * is well under a thousand tokens each way) and the quality of the judgement
 * about what mattered last week is the whole point of the feature.
 */
const NARRATIVE_MODEL = "claude-opus-5";

/** Hard ceiling on the paragraph. Two or three sentences is the brief. */
const NARRATIVE_MAX_TOKENS = 512;

/**
 * Give up well inside the poller's tick. The digest still sends without the
 * paragraph, so waiting longer trades a guaranteed delay for a maybe-paragraph.
 */
const NARRATIVE_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = [
  "You write the opening paragraph of an infrastructure cost digest that an engineering team reads on a Monday morning.",
  "",
  "You are given a JSON summary of one organization's week: spend totals per currency with the change against the previous week, the biggest week-over-week movers by cloud provider and by service, how many sync incidents opened, and how many resources were added or removed.",
  "",
  "Write ONE paragraph of at most three sentences that says what actually mattered. Lead with the thing a reader would want to know first — usually the direction and size of the spend change, or the single mover that explains it. Name the specific provider or service responsible when the numbers point at one. If the week was unremarkable, say so plainly in a sentence rather than manufacturing significance.",
  "",
  "Rules:",
  "- Plain prose. No markdown, no headings, no bullet points, no emoji.",
  "- Do not restate every number — the exact figures are printed directly beneath your paragraph, so repeating them wastes the reader's time. Cite a figure only when it carries the point.",
  "- Do not speculate about causes you cannot see in the data. You do not know what the team deployed, and guessing reads as noise.",
  "- Do not give advice, recommend actions, or ask questions.",
  "- Do not open with a greeting, a preamble, or a restatement of the task. Output the paragraph and nothing else.",
].join("\n");

/**
 * The exact shape sent to the model: an allowlist over `WeeklyDigest`, built by
 * naming each field rather than serializing the object, so widening what leaves
 * the deployment has to be a deliberate edit to this function.
 */
export function digestPromptPayload(digest: WeeklyDigest): Record<string, unknown> {
  const mover = (m: { key: string; currency: string; currentAmount: number; delta: number }) => ({
    name: m.key,
    spend: formatAmount(m.currentAmount, m.currency),
    change: formatAmount(m.delta, m.currency),
  });
  return {
    weekOf: `${digest.window.weekStart} to ${digest.window.weekEnd}`,
    spend: digest.totals.map((t) => ({
      currency: t.currency,
      thisWeek: formatAmount(t.currentAmount, t.currency),
      lastWeek: formatAmount(t.previousAmount, t.currency),
      change: formatAmount(t.delta, t.currency),
      changePercent: t.deltaPct === null ? null : Number(t.deltaPct.toFixed(1)),
    })),
    topProviderMovers: digest.topProviderMovers.map(mover),
    topServiceMovers: digest.topServiceMovers.map(mover),
    syncIncidentsOpened: digest.syncIncidentsOpened,
    resourcesAdded: digest.resourcesAdded,
    resourcesRemoved: digest.resourcesRemoved,
  };
}

/** Whether this deployment can write narratives at all. */
export function isNarrativeConfigured(): boolean {
  return Boolean(process.env["ANTHROPIC_API_KEY"]);
}

/**
 * Write the paragraph, or return null. Never throws.
 *
 * @param digest the already-composed digest — the only thing the model sees.
 */
export async function generateDigestNarrative(digest: WeeklyDigest): Promise<string | null> {
  if (!isNarrativeConfigured()) {
    console.warn(
      "[digest] narrative requested but ANTHROPIC_API_KEY is not set on this deployment; sending the deterministic digest only.",
    );
    return null;
  }

  try {
    const client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
      timeout: NARRATIVE_TIMEOUT_MS,
      // The digest is not latency-sensitive but it is also not worth a long
      // retry storm inside a tick; one retry is enough to ride out a blip.
      maxRetries: 1,
    });

    const response = await client.messages.create({
      model: NARRATIVE_MODEL,
      max_tokens: NARRATIVE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // A short summary of a dozen numbers needs no deliberation, and low
      // effort keeps both the latency and the bill down.
      output_config: { effort: "low" },
      messages: [{ role: "user", content: JSON.stringify(digestPromptPayload(digest)) }],
    });

    // Safety classifiers answer 200 with `stop_reason: "refusal"` and no
    // content, so check it before reading blocks.
    if (response.stop_reason === "refusal") {
      console.warn("[digest] narrative refused by the model; sending without it.");
      return null;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    // Everything is recoverable here: the digest sends without the paragraph.
    console.error("[digest] narrative generation failed; sending without it:", err);
    return null;
  }
}

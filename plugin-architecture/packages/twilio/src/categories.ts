/**
 * Twilio usage categories.
 *
 * The Usage Records API returns one record per category, and the categories
 * overlap: `calls` contains `calls-inbound` which contains
 * `calls-inbound-local`; `pv` contains every Programmable Video category;
 * `authy-sms-outbound` is "also included in the SMS categories"; and
 * `totalprice` is everything. Twilio publishes no hierarchy field, so summing
 * every record's `price` counts the same dollar two or three times.
 *
 * `selectLeafCategories` picks a set of priced categories with no known
 * containment between them, which is what `cost-data.ts` emits rows for; it
 * then reconciles the leaves against `totalprice` (the real billed figure) so
 * the total is always right even when Twilio adds a rollup this table does
 * not know about.
 *
 * Category list and descriptions: https://www.twilio.com/docs/usage/api/usage-record#usage-categories
 * (verified 2026-10).
 */

/** The billed total of every category. Never a leaf. */
export const TOTAL_CATEGORY = "totalprice";

/**
 * Rollups whose children do not share their name as a prefix. A rollup is
 * dropped only when at least one of its children carries a price, so an
 * account where only the rollup reports (some video plans report just `pv`)
 * still keeps its cost.
 */
const EXPLICIT_ROLLUPS: Record<string, string[]> = {
  // "All Programmable Video usage including TURN."
  pv: [
    "group-rooms",
    "group-rooms-participant-minutes",
    "group-rooms-data-track",
    "group-rooms-recorded-minutes",
    "group-rooms-encrypted-media-recorded",
    "group-rooms-media-stored",
    "group-rooms-media-downloaded",
    "small-group-rooms",
    "small-group-rooms-participant-minutes",
    "small-group-rooms-data-track",
    "pv-rooms",
    "peer-to-peer-rooms-participant-minutes",
    "video-recordings",
    "pv-composition-minutes",
    "turnmegabytes",
  ],
  // "All usage regarding video Recordings and Compositions."
  "video-recordings": [
    "group-rooms-recorded-minutes",
    "pv-composition-minutes",
    "group-rooms-encrypted-media-recorded",
    "group-rooms-media-stored",
    "group-rooms-media-downloaded",
  ],
  // "Recordings of voice and trunking calls."
  recordings: ["calls-recordings", "trunking-recordings"],
  // "All Lookups executed across all categories."
  lookups: [
    "carrier-lookups",
    "calleridlookups",
    "number-format-lookups",
    "call-forwarding-lookups",
    "sim-swap-lookups",
    "live-activity-lookups",
    "enhanced-line-type-lookups",
    "identity-match",
  ],
  // Flex voice: connectivity includes PSTN, SIP and Client calls.
  programmablevoiceconnectivity: [
    "pstnconnectivity",
    "pstnconnectivity-inbound",
    "pstnconnectivity-outbound",
    "programmablevoiceconn-sip",
    "programmablevoiceconn-sip-inbound",
    "programmablevoiceconn-sip-outbound",
    "programmablevoiceconn-clientsdk",
  ],
  "usage-rcs-messages": [
    "usage-rcs-basic-messages-outbound",
    "usage-rcs-single-messages-outbound",
    "usage-rcs-messages-inbound",
  ],
};

/**
 * Categories that duplicate usage already counted elsewhere and are never
 * leaves: Twilio's own descriptions say so ("Note that this usage is also
 * included in the SMS categories").
 */
const DUPLICATE_CATEGORIES = new Set(["authy-sms-outbound", "authy-calls-outbound"]);

/**
 * Prefix containment that is *not* real: these categories start with another
 * category's name and a hyphen but are billed beside it, not inside it.
 * Treating them as children would be harmless only if the parent's other
 * children were always priced; listing them keeps a priced parent alive.
 */
const NOT_CHILDREN: Record<string, string[]> = {
  calls: ["calls-sip", "calls-client", "calls-globalconference", "calls-media-stream-minutes"],
};

const norm = (category: string): string => category.trim().toLowerCase();

/**
 * Choose the priced categories to emit rows for: every priced category that
 * no other priced category refines. `priced` maps category → price over the
 * period being collected (only categories with a non-zero price matter).
 */
export function selectLeafCategories(priced: Map<string, number>): string[] {
  const names = [...priced.keys()].filter((c) => (priced.get(c) ?? 0) !== 0);
  const lower = new Map(names.map((n) => [norm(n), n]));
  const leaves: string[] = [];
  for (const name of names) {
    const key = norm(name);
    if (key === TOTAL_CATEGORY || DUPLICATE_CATEGORIES.has(key)) continue;
    const explicit = EXPLICIT_ROLLUPS[key];
    if (explicit && explicit.some((child) => lower.has(child))) continue;
    const excluded = new Set(NOT_CHILDREN[key] ?? []);
    const refined = [...lower.keys()].some(
      (other) =>
        other !== key &&
        other.startsWith(`${key}-`) &&
        ![...excluded].some((x) => other === x || other.startsWith(`${x}-`)),
    );
    if (refined) continue;
    leaves.push(name);
  }
  return leaves.sort();
}

/** Product families, by category prefix (first match wins). */
const PRODUCTS: Array<[RegExp, string]> = [
  [/^sms|^a2p-registration-fees$/, "SMS"],
  [/^mms|^mediastorage$/, "MMS"],
  [/^verify|^authy/, "Verify"],
  [/^channels-whatsapp/, "WhatsApp"],
  [/^channels-/, "Messaging Channels"],
  [/^usage-rcs|^rcs-/, "RCS"],
  [/^phonenumbers|^shortcodes/, "Phone Numbers"],
  [/lookups$|^identity-match$/, "Lookup"],
  [/^trunking|sip-trunking/, "Elastic SIP Trunking"],
  [
    /^pv|^group-rooms|^small-group-rooms|^peer-to-peer-rooms|^video-recordings|^turnmegabytes/,
    "Video",
  ],
  [/^pchat|^conversations/, "Conversations"],
  [/^sync/, "Sync"],
  [/^taskrouter/, "TaskRouter"],
  [/^studio/, "Studio"],
  [/^monitor-/, "Monitor"],
  [/^events$/, "Event Streams"],
  [/^pfax/, "Programmable Fax"],
  [/^engagement-suite|features-engagement-suite/, "Engagement Suite"],
  [/^premiumsupport$/, "Support"],
  [/^wireless|^iot/, "IoT"],
  [/^flex|^programmablevoice|^pstnconnectivity/, "Flex"],
  [
    /^calls|^call-|^agent-conference|^answering-machine|^amazon-polly|^tts-|^recording|^transcriptions|^speech-recognition|^virtual-agent|^ivr-|^voice-/,
    "Voice",
  ],
];

/** The product family a category bills under, for the `service` dimension. */
export function productOf(category: string): string {
  const key = norm(category);
  for (const [pattern, label] of PRODUCTS) if (pattern.test(key)) return label;
  return "Other";
}

/**
 * Categories offered first in the usage-trigger picker: the ones people put
 * budgets on. Everything else Twilio reports follows, alphabetically.
 */
export const COMMON_TRIGGER_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "totalprice", label: "Total spend (all usage)" },
  { id: "sms", label: "SMS (all)" },
  { id: "mms", label: "MMS (all)" },
  { id: "calls", label: "Voice calls" },
  { id: "phonenumbers", label: "Phone numbers" },
  { id: "channels-whatsapp-template-marketing", label: "WhatsApp marketing templates" },
  { id: "authy-phone-verifications", label: "Verify SMS and voice verifications" },
  { id: "lookups", label: "Lookups (all)" },
  { id: "recordings", label: "Recordings" },
  { id: "pv", label: "Video (all)" },
];

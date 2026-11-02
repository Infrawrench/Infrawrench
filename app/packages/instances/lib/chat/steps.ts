import type { ChatTurn, SignedToolStep, ToolCallRecord } from "./types";
import { STEP_HISTORY_ANSWERS } from "./types";

/**
 * Earlier answers' tool calls, kept by the browser and handed back to the
 * model on the next turn, so a follow-up can see the queries an answer ran
 * and what they returned instead of only the text written from them.
 *
 * The browser is not trusted with results the model will treat as real, so
 * each round of calls is signed with an HMAC when it runs and checked when it
 * comes back; a step that fails the check is dropped, and that answer falls
 * back to its text and view notes. The key is derived (HKDF) from the
 * warehouse read token the chat already needs, so there is nothing extra to
 * configure; rotating the token only means older conversations lose their
 * results.
 */

/** Characters of earlier tool calls (inputs and results) a turn sends the model. */
export const MAX_HISTORY_STEP_CHARS = 80_000;

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function stepKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(),
            info: encoder.encode("instances-chat-tool-steps"),
          },
          base,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      );
    keys.set(secret, key);
  }
  return key;
}

const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function signStep(secret: string, calls: ToolCallRecord[]): Promise<SignedToolStep> {
  const data = JSON.stringify(calls);
  const sig = await crypto.subtle.sign("HMAC", await stepKey(secret), encoder.encode(data));
  return { data, sig: toBase64(sig) };
}

/** The step's calls, or null when it was not signed with this secret or is not in the expected shape. */
export async function openStep(
  secret: string,
  step: SignedToolStep,
): Promise<ToolCallRecord[] | null> {
  const sig = fromBase64(step.sig);
  if (!sig) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await stepKey(secret),
    sig,
    encoder.encode(step.data),
  );
  if (!valid) return null;
  try {
    const calls = JSON.parse(step.data) as ToolCallRecord[];
    return Array.isArray(calls) && calls.length > 0 ? calls : null;
  } catch {
    return null;
  }
}

/** A turn as the model gets it: an answer's tool calls checked and decoded, one array per round. */
export type HistoryTurn = Omit<ChatTurn, "steps"> & { steps?: ToolCallRecord[][] };

const stepChars = (calls: ToolCallRecord[]) =>
  calls.reduce((n, c) => n + c.result.length + JSON.stringify(c.input ?? null).length, 0);

/**
 * Checks and decodes the steps of the newest `STEP_HISTORY_ANSWERS` answers,
 * newest first, within `MAX_HISTORY_STEP_CHARS`. An answer keeps all of its
 * steps or none (a partial set would show the model half of what it did); an
 * answer without them gets its view notes instead (`toMessages`).
 */
export async function openHistory(secret: string, turns: ChatTurn[]): Promise<HistoryTurn[]> {
  const out: HistoryTurn[] = turns.map(({ steps: _steps, ...turn }) => turn);
  let answers = 0;
  let budget = MAX_HISTORY_STEP_CHARS;
  for (let i = turns.length - 1; i >= 0 && answers < STEP_HISTORY_ANSWERS; i--) {
    const steps = turns[i]!.steps;
    if (turns[i]!.role !== "assistant" || !steps?.length) continue;
    answers++;
    const opened = await Promise.all(steps.map((s) => openStep(secret, s)));
    if (opened.some((calls) => calls === null)) continue;
    const decoded = opened as ToolCallRecord[][];
    const chars = decoded.reduce((n, calls) => n + stepChars(calls), 0);
    if (chars > budget) continue;
    budget -= chars;
    out[i]!.steps = decoded;
  }
  return out;
}

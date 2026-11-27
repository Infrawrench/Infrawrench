/**
 * Masking secrets in what agents record: trace bodies, commands and their
 * output. It runs when an entry is written, so nothing unmasked is ever
 * stored, and it is deliberately eager: a trace that hides a harmless string
 * loses little, one that keeps a token loses a credential.
 *
 * What it knows, in the order it is applied:
 *
 * 1. Credentials by their shape, whatever is around them: this forge's and
 *    the app's tokens (every `iw?_` prefix, so a kind added later is covered
 *    the day it is minted), the common providers' keys, JWTs, private key
 *    blocks, webhook addresses that are themselves the secret.
 * 2. A credential in a URL: `scheme://user:password@host`, and a long token
 *    in the user's place (`https://<token>@host`).
 * 3. Headers that carry one: `Authorization`, `Cookie`, `Set-Cookie`, and a
 *    bare `Bearer x` or `Basic x`.
 * 4. Values by the name they are given to: `TOKEN=...`, `"password": "..."`,
 *    `--api-key ...`, `curl -u user:password`.
 * 5. Values that look random given to a name that looks like configuration
 *    (`SOME_SETTING=4f9a...`), whatever the name says.
 *
 * It is a filter over text, not a parser: it cannot know a secret that has
 * no shape and no name (a password in a sentence). The tool descriptions
 * tell agents not to record one; this is what catches the ones they do.
 *
 * Every pattern is linear in the text: a name or a value is matched from a
 * boundary, never from every character, so a long line of one character
 * costs one pass.
 */

export const MASK = "***";

/** Credentials recognisable on sight, whatever is around them. */
const SHAPES: readonly RegExp[] = [
  // PEM private keys, whole (PKCS#1, PKCS#8, OpenSSH, PGP), and one cut short.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----|$)/g,
  /\bAGE-SECRET-KEY-1[A-Z0-9]{20,}/g,
  // This forge's and the app's own: personal tokens, API keys, job tokens, and what OAuth mints.
  /\biw[a-z]_[A-Za-z0-9._-]{8,}/g,
  // GitHub, GitLab.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgl(?:pat|dt|rt|cbt|ptt|ft|imt|agent|oas|soat)-[A-Za-z0-9_-]{16,}/g,
  // Slack tokens, and the webhooks whose address is the credential.
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
  /https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
  // Stripe (and WorkOS, which shares the shape): secret and restricted keys, webhook secrets.
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  // Package registries.
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{30,}/g,
  // AWS access key ids, Google API keys and OAuth access tokens.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  // Model providers (`sk-`, `sk-ant-`, `sk-proj-`), Hugging Face, Replicate.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\br8_[A-Za-z0-9]{30,}\b/g,
  // Other platforms whose tokens say what they are.
  /\bdop_v1_[a-f0-9]{40,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bhv[sb]\.[A-Za-z0-9_-]{20,}/g,
  /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{20,}/g,
  /\bdapi[a-f0-9]{32}\b/g,
  /\bsntry[sua]_[A-Za-z0-9_=-]{20,}/g,
  /\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}\b/g,
  /\blin_api_[A-Za-z0-9]{20,}\b/g,
  /\bnapi_[A-Za-z0-9]{20,}\b/g,
  /\bsbp_[A-Za-z0-9]{20,}\b/g,
  /\bsb_secret_[A-Za-z0-9_-]{16,}/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\bdp\.(?:st|pt|ct|sa)\.[A-Za-z0-9._-]{20,}/g,
  /\bFlyV1 [A-Za-z0-9+/=,_-]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

/** `scheme://user:password@host`: the password alone. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;

/** `scheme://<token>@host`: a long user with no password is a token (`https://<token>@github.com`). */
const URL_TOKEN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]{20,}@/gi;

/** `Authorization: <scheme> x`, `Authorization: x`, `Cookie: ...`: the rest of the value. */
const CREDENTIAL_HEADER =
  /((?<![A-Za-z0-9_-])(?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:(?:Bearer|Basic|Token|Digest|Negotiate|AWS4-HMAC-SHA256)\s+)?)([^\s"'`,;]+)/gi;
const COOKIE_HEADER = /((?<![A-Za-z0-9_-])(?:set-)?cookie["']?\s*:\s*)([^\n"']+)/gi;

/** A bare `Bearer x` or `Basic x`. */
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

/** Words that say the thing they name is a secret. */
const SECRET_WORDS =
  "secret|token|passw(?:or)?d|passphrase|pwd|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|credentials?|session[_-]?id|auth[_-]?key|dsn|connection[_-]?string";

/**
 * A name that says its value is a secret, then `=` or `:`, then the value.
 * The name starts where a word does, so a path (`src/token: 3 files`) is not
 * one, and a value that is already masked is left as it is.
 */
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_./-])((?:[A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;&]+)`,
  "gi",
);

/** `--password hunter2`, `--api-key abc`: a flag named for a secret, then its value after a space. */
const FLAG = new RegExp(
  `((?<![A-Za-z0-9_-])--?[A-Za-z0-9-]*(?:${SECRET_WORDS})[A-Za-z0-9-]*\\s+)("[^"\\n]*"|'[^'\\n]*'|[^\\s"'-][^\\s"']*)`,
  "gi",
);

/** `curl -u user:password`, `--user user:password`. */
const USER_FLAG = /((?<![A-Za-z0-9_-])(?:-u|--user)\s+["']?[^\s:"']+:)([^\s"']+)/g;

/**
 * `NAME=value` where the name is configuration (`UPPER_SNAKE`) and the value
 * is one long run of token characters. Whether it is masked is
 * {@link looksRandom}'s to say.
 */
const ENV_ASSIGNMENT =
  /((?<![A-Za-z0-9_./-])[A-Z][A-Z0-9_]{2,}=["']?)([A-Za-z0-9+/_=-]{20,})(?![A-Za-z0-9+/_=.:-])/g;

/** Bits per character of `value`, counting each character's frequency. */
export const entropy = (value: string): number => {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    bits -= share * Math.log2(share);
  }
  return bits;
};

/**
 * Whether a value given to a configuration name reads as generated rather
 * than written. A commit id (40 hex digits) is the one random-looking value
 * a trace is full of and must keep; a word, a path or a version is not long
 * and mixed enough to count.
 */
export const looksRandom = (value: string): boolean => {
  if (/^[0-9a-f]{40}$/.test(value)) return false;
  // A path, which is long and mixed without being generated.
  if (value.startsWith("/") || value.startsWith(".")) return false;
  if (/^[0-9a-f]+$/i.test(value)) return value.length >= 32 && entropy(value) >= 3;
  const kinds =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
  return kinds >= 2 && entropy(value) >= 3.7;
};

const maskValue = (whole: string, name: string, value: string): string => {
  if (value === MASK || value === "Bearer" || value === "Basic") return whole;
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
  if (quote !== "" && value.slice(1, -1) === MASK) return whole;
  return `${name}${quote}${MASK}${quote}`;
};

/** `text` with everything that looks like a credential replaced by {@link MASK}. */
export const maskSecrets = (text: string): string => {
  let masked = text;
  for (const shape of SHAPES) masked = masked.replace(shape, MASK);
  masked = masked.replace(URL_PASSWORD, `$1:${MASK}@`);
  masked = masked.replace(URL_TOKEN, `$1${MASK}@`);
  masked = masked.replace(CREDENTIAL_HEADER, `$1$2${MASK}`);
  masked = masked.replace(COOKIE_HEADER, `$1${MASK}`);
  masked = masked.replace(AUTHORIZATION, `$1 ${MASK}`);
  masked = masked.replace(ASSIGNMENT, maskValue);
  masked = masked.replace(FLAG, maskValue);
  masked = masked.replace(USER_FLAG, `$1${MASK}`);
  masked = masked.replace(ENV_ASSIGNMENT, (whole, name: string, value: string) =>
    looksRandom(value) ? `${name}${MASK}` : whole,
  );
  return masked;
};

/** {@link maskSecrets} for a value that may be absent. */
export const maskOptional = (text: string | null | undefined): string | null =>
  text == null ? null : maskSecrets(text);

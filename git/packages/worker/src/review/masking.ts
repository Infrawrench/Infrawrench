/**
 * Masking secrets in what agents record: trace bodies, commands and their
 * output. It runs when an entry is written, so nothing unmasked is ever
 * stored, and it is deliberately eager: a trace that hides a harmless string
 * loses little, one that keeps a token loses a credential.
 *
 * What it knows: credentials by their shape (this forge's and the app's
 * tokens, the common providers' keys, JWTs, private key blocks, URLs with a
 * password), and values by the name they are assigned to (`TOKEN=...`,
 * `"password": "..."`, `Authorization: Bearer ...`).
 */

export const MASK = "***";

/** Credentials recognisable on sight, whatever is around them. */
const SHAPES: readonly RegExp[] = [
  // PEM private keys, whole.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // This forge's and the app's own: personal tokens, API keys, job tokens.
  /\biw[gkj]_[A-Za-z0-9._-]{8,}/g,
  // GitHub, GitLab, Slack, Stripe, npm.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  // AWS access key ids, and Google API keys.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // Model providers.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

/** `scheme://user:password@host`: the password alone. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;

/** `Authorization: Bearer x`, `Basic x`, and a bare `Bearer x`. */
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

/**
 * A name that says its value is a secret, then `=` or `:`, then the value.
 * The name starts where a word does, so a path (`src/token: 3 files`) is not
 * one, and a value that is already masked is left as it is.
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_./-])((?:[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi;

/** `text` with everything that looks like a credential replaced by {@link MASK}. */
export const maskSecrets = (text: string): string => {
  let masked = text;
  for (const shape of SHAPES) masked = masked.replace(shape, MASK);
  masked = masked.replace(URL_PASSWORD, `$1:${MASK}@`);
  masked = masked.replace(AUTHORIZATION, `$1 ${MASK}`);
  masked = masked.replace(ASSIGNMENT, (whole, name: string, value: string) => {
    if (value === MASK || value === "Bearer" || value === "Basic") return whole;
    const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
    return `${name}${quote}${MASK}${quote}`;
  });
  return masked;
};

/** {@link maskSecrets} for a value that may be absent. */
export const maskOptional = (text: string | null | undefined): string | null =>
  text == null ? null : maskSecrets(text);

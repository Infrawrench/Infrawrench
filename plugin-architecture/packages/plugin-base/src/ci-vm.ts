/**
 * Helpers for CI executors that start a fresh Linux machine from a stock
 * image and hand it the job through cloud-init user data: the VPS clouds
 * (DigitalOcean, Hetzner, Linode, Vultr, UpCloud, Scaleway, OVHcloud,
 * Exoscale, Civo) and OpenStack. Nothing here knows a provider.
 *
 * - {@link ciCloudInitScript}: the user data, a shell script cloud-init runs
 *   once, as root, on first boot, behind a `shutdown -h` timer.
 * - Tags: many of these providers keep tags as plain strings, or labels
 *   with narrow character sets, so the CI tags travel encoded
 *   ({@link ciTagStrings}, {@link ciEncodeTagValue}) and come back exactly as
 *   they were sent.
 * - {@link ciThrowawaySshKey}: a public key whose private half is never kept,
 *   for providers that otherwise email a root password for every machine.
 */
import { bytesToBase64 } from "./base64.js";
import { CI_JOB_TAG, CI_RUN_TAG, CI_TAG, ciComputeKey, type CiStartSpec } from "./ci.js";

/**
 * The user data for a job's machine: a `#!/bin/bash` script, which
 * cloud-init runs once as root on first boot. It sets the backstop first, a
 * `shutdown -h` timer at `maxSeconds`, so the machine powers off once the
 * job's time is up whatever happens to the host or the bootstrap; then it
 * runs the bootstrap, and powers off when that ends.
 *
 * Powering off stops the work, not always the bill: on providers that bill
 * a stopped server, billing stops only when the host tears it down or the
 * reaper removes it. The machine is never handed the provider's credentials,
 * so it cannot delete itself.
 */
export function ciCloudInitScript(bootstrap: string, maxSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return [
    "#!/bin/bash",
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "(",
    body,
    ")",
    "shutdown -h now",
    "",
  ].join("\n");
}

/**
 * The machine's name: `iwci-` and the job's {@link ciComputeKey}, 37
 * characters of lowercase letters, digits and `-`. A valid hostname, and the
 * same for every start of the same job, so a start can look for it first.
 */
export function ciMachineName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

const SAFE = /[A-Za-z0-9-]/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * A tag value in letters, digits and `-` only: any other character becomes
 * `_` and its UTF-8 bytes in two-digit hex (`_` itself is `_5f`), and so does
 * a `-` at either end, so the result starts and ends with a letter or digit
 * when it is not empty. It fits DigitalOcean tag names, Hetzner and UpCloud
 * label values and every looser rule; {@link ciDecodeTagValue} reverses it.
 */
export function ciEncodeTagValue(value: string): string {
  const chars = Array.from(value);
  return chars
    .map((ch, i) => {
      const edge = i === 0 || i === chars.length - 1;
      if (edge ? ALNUM.test(ch) : SAFE.test(ch)) return ch;
      return Array.from(new TextEncoder().encode(ch))
        .map((b) => `_${b.toString(16).padStart(2, "0")}`)
        .join("");
    })
    .join("");
}

/** The value {@link ciEncodeTagValue} encoded. */
export function ciDecodeTagValue(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const hex = text.slice(i + 1, i + 3);
    if (ch === "_" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(ch));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Short names for the CI tag keys, so a tag fits providers that cap tags at 50 characters. */
const SHORT_KEYS: Readonly<Record<string, string>> = {
  [CI_TAG]: "iwci",
  [CI_RUN_TAG]: "iwci-run",
  [CI_JOB_TAG]: "iwci-job",
};
const LONG_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SHORT_KEYS).map(([long, short]) => [short, long]),
);

/**
 * The plain string tag that marks a key's presence, whatever its value: the
 * one a provider's "list by tag" filter can match. `iwci` for {@link CI_TAG}.
 */
export function ciTagMarker(key: string): string {
  return SHORT_KEYS[key] ?? ciEncodeTagValue(key);
}

/**
 * Tags as plain strings, for providers whose tags have no value: for each
 * key, its marker ({@link ciTagMarker}) and `marker:value` with the value
 * encoded. `{ "infrawrench-ci": "org-org_01H" }` becomes `iwci` and
 * `iwci:org-org_5f01H`. Every string is at most 50 characters for the CI
 * tags the host sends.
 */
export function ciTagStrings(tags: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    out.push(ciTagMarker(key));
    if (value) out.push(ciTagString(key, value));
  }
  return out;
}

/** One key and value as {@link ciTagStrings} writes it, e.g. to look a job's machine up by tag. */
export function ciTagString(key: string, value: string): string {
  return `${ciTagMarker(key)}:${ciEncodeTagValue(value)}`;
}

/**
 * The tags {@link ciTagStrings} wrote, back as they were sent, from all of a
 * resource's tags; other tags are ignored. A marker without a value reads as
 * an empty value.
 */
export function ciTagsFromStrings(strings: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of strings) {
    const colon = tag.indexOf(":");
    const marker = colon < 0 ? tag : tag.slice(0, colon);
    const key = LONG_KEYS[marker];
    if (!key) continue;
    if (colon < 0) {
      out[key] ??= "";
    } else {
      out[key] = ciDecodeTagValue(tag.slice(colon + 1));
    }
  }
  return out;
}

/**
 * The status of a failed HTTP call, from an error's `status` or
 * `statusCode`, or from a message such as `Hetzner API error 404 for ...`.
 */
export function ciHttpStatus(err: unknown): number | undefined {
  const record = err as { status?: unknown; statusCode?: unknown } | null;
  for (const value of [record?.status, record?.statusCode]) {
    if (typeof value === "number") return value;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = /\b(?:API error|HTTP|status)\s*:?\s*(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** A password nobody keeps, for providers that refuse to create a machine without one. */
export function ciThrowawayPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Letters, digits and symbols, so it meets every provider's strength rule.
  return `Iw1!${bytesToBase64(bytes).replace(/[+/=]/g, "x")}`;
}

/**
 * An `ssh-ed25519` public key whose private half is dropped as soon as it is
 * made. Some providers email a root password for every machine started
 * without an SSH key; handing them this one stops that, and nobody can log
 * in with it.
 */
export async function ciThrowawaySshKey(comment = "infrawrench-ci"): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const type = new TextEncoder().encode("ssh-ed25519");
  const blob = new Uint8Array(4 + type.length + 4 + raw.length);
  const view = new DataView(blob.buffer);
  view.setUint32(0, type.length);
  blob.set(type, 4);
  view.setUint32(4 + type.length, raw.length);
  blob.set(raw, 8 + type.length);
  return `ssh-ed25519 ${bytesToBase64(blob)} ${comment}`;
}

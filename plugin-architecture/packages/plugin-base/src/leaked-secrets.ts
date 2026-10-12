/**
 * Leaked credentials: two halves of one loop, each a separate declaration.
 *
 * - A **scanner** (a provider that finds secrets committed to code, such as
 *   GitHub secret scanning or GitLab secret detection) declares
 *   `manifest.secretScanning` and implements
 *   {@link PluginClient.listLeakedSecrets} (and, when it can close an alert,
 *   {@link PluginClient.resolveLeakedSecret}). It reports findings in its own
 *   vocabulary: `tokenType` is whatever identifier the scanner uses.
 * - An **owner** (a provider that issues the token that leaked) declares
 *   `manifest.tokenFormats`: which scanner identifiers and which literal
 *   prefixes are its tokens, which credential fields hold them, and where the
 *   provider's own key management page lives.
 *
 * The host joins the two. A finding is matched to the account or stored
 * secret it belongs to by a keyed, non-reversible fingerprint computed on the
 * host from the scanner's raw value and from the credentials the host already
 * holds; neither value is ever sent anywhere or stored. When the scanner
 * withholds the raw value, the match falls back to "an account of the plugin
 * that owns this token type", which the host presents as a candidate, never as
 * a certainty. Nothing in the host knows any provider's token format.
 */

/** What the host shows for a scanner. */
export interface SecretScanningDeclaration {
  /** The scanner's product name, e.g. "Secret scanning", "Secret detection". */
  label: string;
  /** One line under the label: what is scanned and what the account needs. */
  description?: string;
  /**
   * True when {@link PluginClient.resolveLeakedSecret} is implemented: after a
   * rotation the host offers to close the upstream alert as revoked.
   */
  canResolve: boolean;
  /**
   * True when findings normally carry the raw secret (`LeakedSecretFinding.secret`),
   * so matches are by fingerprint. False when they never do, so the host
   * explains that matches are by token type only.
   */
  returnsSecretValue: boolean;
}

/** Where a leaked secret was found. Every part is optional. */
export interface LeakedSecretLocation {
  /** `owner/name`, or the scanner's project path. */
  repository?: string;
  /** File path inside the repository. */
  path?: string;
  line?: number;
  commitSha?: string;
}

/** One finding, as the scanner reports it. */
export interface LeakedSecretFinding {
  /**
   * Stable id of the finding within this scanner account, used to dedupe
   * across passes and passed back to `resolveLeakedSecret`. e.g.
   * `octo-org/app#42` or a GraphQL global id.
   */
  ref: string;
  /** The scanner's own identifier for the kind of token. */
  tokenType: string;
  /** The scanner's human name for it, when it has one. */
  tokenTypeLabel?: string;
  /**
   * The raw secret, when the scanner returns it. The host fingerprints it in
   * memory and discards it: it is never persisted, logged or sent anywhere.
   * Omit when the scanner withholds it.
   */
  secret?: string;
  state: "open" | "resolved";
  /** The scanner's word for why it was resolved (`revoked`, `false_positive`). */
  resolution?: string;
  location?: LeakedSecretLocation;
  /** The finding's page on the scanner. */
  url?: string;
  /** ISO timestamp the scanner first saw it. */
  detectedAt: string;
  /** ISO timestamp of the scanner's last change to it. */
  updatedAt?: string;
  /** The scanner found it in a public place as well. */
  publiclyLeaked?: boolean;
  /** Whether the scanner checked the token against its issuer. */
  validity?: "active" | "inactive" | "unknown";
}

export interface LeakedSecretQuery {
  /** Upper bound on findings returned; the plugin pages until it is reached. */
  limit: number;
  /** Include findings the scanner already considers resolved. */
  includeResolved: boolean;
}

export interface LeakedSecretPage {
  findings: LeakedSecretFinding[];
  /** True when more findings exist than `limit` allowed. */
  truncated: boolean;
}

/** Why the host is closing a finding upstream. */
export type LeakedSecretResolutionReason =
  "revoked" | "false-positive" | "wont-fix" | "used-in-tests";

export interface LeakedSecretResolution {
  reason: LeakedSecretResolutionReason;
  /** Free text the scanner stores beside the resolution, when it can. */
  comment?: string;
}

/**
 * A token this plugin issues, declared so the host can tell whose leak a
 * finding is. Declared by the plugin that owns the token, never by the
 * scanner.
 */
export interface TokenFormatDeclaration {
  /** Stable id within the plugin, e.g. "api-token". */
  id: string;
  /** What the provider calls it, e.g. "API token". */
  label: string;
  /**
   * Identifiers scanners report this token under, compared case-insensitively
   * across every scanner (GitHub's `secret_type` values and GitLab's rule ids
   * do not collide in practice, and where they do they name the same token).
   */
  scannerTypes: string[];
  /**
   * Literal prefixes the token always starts with (`dop_v1_`, `sk-ant-`).
   * Checked on the host against the raw value when the scanner's identifier is
   * not specific enough, so a generic finding can still be attributed.
   */
  prefixes?: string[];
  /**
   * Credential field keys that hold this token on an account. Defaults to
   * every `sensitive` credential field when omitted.
   */
  credentialFields?: string[];
  /**
   * The provider's own page for revoking and reissuing this token, offered
   * when the host has no one-click rotation for the match.
   */
  manageUrl?: string;
}

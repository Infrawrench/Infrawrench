/**
 * Prepaid-credit contract.
 *
 * Distinct from the cost contract next door, and deliberately so. `costs` is
 * "what did this account spend" — a time series, backfilled, dimensioned.
 * `credits` is "how much is left in the pot", a single number the provider
 * either exposes or does not. Most providers bill in arrears and have no pot;
 * the ones that do (prepaid AI inference, trial grants, committed-spend
 * balances) are exactly the ones where running out is an *outage*, not an
 * invoice — the API stops answering.
 *
 * That is the whole reason this exists as its own capability: a balance
 * without a burn rate is a number nobody acts on, and the host can compute the
 * burn from the series of balances it collects. The plugin's job is only to
 * report the pot.
 */

/** Declares that this plugin can report a prepaid credit balance. */
export interface CreditsCapabilityDeclaration {
  /**
   * What the provider calls it, for the UI: "Credits", "Prepaid balance",
   * "Account balance". Defaults to "Credits" when absent — using the
   * provider's own word matters because the user is going to go and look for
   * it in the provider's console.
   */
  label?: string;
  /** Where the user tops up. Rendered as the "Add credit" link. */
  topUpUrl?: string;
  /**
   * True when the balance can only be read with a credential stronger than the
   * one the account normally needs (OpenRouter's `/credits` wants a management
   * key, not an inference key). The host uses this to explain a missing
   * balance as a permission gap rather than a failure.
   */
  requiresElevatedCredential?: boolean;
}

/**
 * One prepaid balance. Providers that split credit by currency or by grant
 * return several; the host sums nothing across currencies and tracks each
 * separately, because "$40 and ¥300" is not a number.
 */
export interface CreditBalance {
  /**
   * Stable identity for this pot within the account, so successive collections
   * line up into a series. A currency code, a grant id — whatever the provider
   * makes stable. Plugins returning a single balance can use `"default"`.
   */
  key: string;
  /** Human label for this pot ("USD balance", "Free trial credit"). */
  label: string;
  /** How much is left, in `currency`. */
  remaining: number;
  /** ISO 4217, e.g. "USD". */
  currency: string;
  /**
   * What was originally granted or topped up, when the provider reports it.
   * Used for a "X of Y remaining" bar; absent is fine and common.
   */
  granted?: number;
  /**
   * When this credit expires regardless of use, when the provider says so.
   * A trial grant that lapses in nine days does not have a 200-day runway no
   * matter how slowly it is being spent, and the host takes the earlier of the
   * two.
   */
  expiresAt?: string;
}

/**
 * Thrown by `fetchCreditBalance` when the balance cannot be read until the
 * user does something — usually swapping in a credential with billing scope.
 * The host surfaces `message` and the link verbatim rather than reporting a
 * generic failure, because "your key can't see this" and "the provider is
 * down" want completely different reactions.
 */
export class CreditAccessError extends Error {
  readonly helpLabel?: string;
  readonly helpUrl?: string;

  constructor(message: string, help?: { label: string; url: string }) {
    super(message);
    this.name = "CreditAccessError";
    if (help) {
      this.helpLabel = help.label;
      this.helpUrl = help.url;
    }
  }
}

/**
 * The `routeAlert` options that carry a settings object's own email
 * recipients. A database-free leaf so the evaluators can import it without
 * their tests having to mock another module.
 */
import type { AlertEmailRecipients } from "@infrawrench/client-core";
import type { RouteAlertOptions } from "./route";

/**
 * One list for commitment expiry, idle commitments and unit-cost regressions
 * because the org tunes them as one decision (`org_cost_efficiency_settings`);
 * `what` names the detector in the footer's "why you got this".
 */
export function efficiencyEmail(
  settings: { emailRecipients?: AlertEmailRecipients | undefined },
  url: string | null,
  what: string,
): Pick<RouteAlertOptions, "emailRecipients" | "emailReason" | "emailManageUrl"> {
  return {
    ...(settings.emailRecipients ? { emailRecipients: settings.emailRecipients } : {}),
    emailReason: `you are on the recipient list for ${what} alerts`,
    emailManageUrl: url,
  };
}

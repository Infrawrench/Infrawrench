/**
 * Credential preflight + least-privilege policy contract.
 *
 * Generalizes the `CostSetupError` pattern (a per-account, user-actionable
 * "your credential can't do X, here's the fix" signal) to every capability a
 * plugin offers. A plugin that opts in:
 *
 *   1. Declares `manifest.preflight` — the list of capabilities the plugin
 *      supports, each with the provider permission strings it needs. The
 *      host renders these generically; it never knows what an IAM action or
 *      a Cloudflare permission group is.
 *   2. Implements `PluginClient.verifyCredentials()` — probes the provider
 *      with the account's credentials and reports per-capability status:
 *      ok / missing (with which permissions) / unknown.
 *   3. Optionally implements `Plugin.policyTemplate(capabilityIds)` — builds
 *      the paste-ready least-privilege credential document (AWS IAM policy
 *      JSON, GCP custom role YAML, Cloudflare token scope template, ...)
 *      scoped to just the capabilities the user selected. Lives on the
 *      Plugin, not the client: generating a template needs no credentials.
 *
 * Plugins that don't declare `preflight` simply don't get the checklist —
 * the host UI degrades to the current behaviour.
 */

/** One provider-native permission with a human explanation. */
export interface PreflightPermission {
  /**
   * The provider's own permission string — exactly what the user would type
   * into their console: an IAM action (`ce:GetCostAndUsage`), a GCP IAM
   * permission (`compute.instances.list`), a Cloudflare token permission
   * group (`Account Analytics Read`), etc.
   */
  id: string;
  /** Short human label, e.g. "Read cost and usage data". */
  label: string;
}

/** A capability the plugin offers that preflight can vouch for. */
export interface PreflightCapability {
  /**
   * Stable capability id, unique within the plugin. Use the conventional ids
   * where they fit so the host can group consistently across plugins:
   * `resources`, `costs`, `metrics`, `logs`, `storage`. Plugin-specific
   * capabilities are fine — the host renders whatever is declared.
   */
  id: string;
  /** Human label rendered as the checklist row, e.g. "Resource inventory". */
  label: string;
  /** One-line explanation of what the capability powers in the app. */
  description?: string;
  /**
   * Permissions the credential needs for this capability. Also the pool the
   * policy template draws from when the user selects this capability.
   */
  requiredPermissions: PreflightPermission[];
  /**
   * False for capabilities the app works without (costs, metrics). True for
   * the ones that make the account useless when missing (resource listing).
   * Defaults to false. The host uses this only for emphasis in the UI.
   */
  essential?: boolean;
}

/** Declares that this plugin supports credential preflight. */
export interface PreflightDeclaration {
  capabilities: PreflightCapability[];
  /**
   * Label of the document `Plugin.policyTemplate` produces, e.g.
   * "AWS IAM policy (JSON)". Present iff the plugin implements
   * `policyTemplate` — the manifest is data, so the host needs the flag
   * here to know whether to offer the generator.
   */
  templateFormat?: {
    label: string;
    /** Syntax for display/copy affordances. */
    language: "json" | "yaml" | "text";
  };
}

/** Result of probing one capability. */
export type PreflightCapabilityCheck =
  | { capabilityId: string; status: "ok" }
  | {
      capabilityId: string;
      status: "missing";
      /**
       * The subset of the capability's `requiredPermissions` the probe found
       * absent. May be empty when the provider reports "denied" without
       * saying which permission — the host then lists all required ones.
       */
      missingPermissions: PreflightPermission[];
      /** Optional provider-specific explanation (setup step, not just IAM). */
      message?: string;
      /** Deep link to the provider console page where the user can fix it. */
      helpLink?: { label: string; url: string };
    }
  | {
      capabilityId: string;
      status: "unknown";
      /** Why the probe couldn't decide (API unreachable, probe unsupported...). */
      message?: string;
    };

/** Everything `verifyCredentials` reports back to the host. */
export interface PreflightResult {
  checks: PreflightCapabilityCheck[];
  /**
   * Provider-side identity the credential resolved to, when the probe learns
   * it for free (an ARN, a service account email, a token id). Shown as
   * confirmation that the right credential was pasted.
   */
  identity?: string;
}

/**
 * Registration-time check of the preflight contract — everything that is
 * checkable without instantiating a client. `PluginClient.verifyCredentials`
 * only exists once `createClient` runs with real credentials, so it cannot be
 * verified here; a missing probe is handled gracefully at probe time by
 * `runAccountPreflight` (every capability reports `unknown` with a clear
 * message). Returns a human-readable problem description, or `null` when the
 * plugin's shape is consistent. Loaders reject plugins that return a problem.
 */
export function validatePreflightContract(plugin: {
  manifest: { preflight?: PreflightDeclaration };
  policyTemplate?(capabilityIds: string[]): PolicyTemplate;
}): string | null {
  const declaration = plugin.manifest.preflight;
  if (!declaration) return null;
  if (declaration.templateFormat && typeof plugin.policyTemplate !== "function") {
    return "manifest.preflight.templateFormat is declared but the plugin does not implement policyTemplate()";
  }
  return null;
}

/** Paste-ready least-privilege credential document. */
export interface PolicyTemplate {
  /** e.g. "AWS IAM policy (JSON)" — same string as the manifest declares. */
  formatLabel: string;
  /** Syntax for display/copy affordances. */
  language: "json" | "yaml" | "text";
  /** The document itself, ready to paste into the provider console. */
  document: string;
  /**
   * Where to paste it — one or two plain sentences, e.g. "Attach as an
   * inline policy on the IAM user whose keys you entered."
   */
  instructions?: string;
  /** Deep link to the provider console page where the document is applied. */
  helpLink?: { label: string; url: string };
}

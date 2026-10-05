import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { DepotClient } from "./client.js";
import { DEFAULT_PLAN_ID, DEPOT_PLANS } from "./rates.js";
import {
  ActionsRepoResourceType,
  BuildResourceType,
  ProjectResourceType,
  RegistryImageResourceType,
  TokenResourceType,
  TrustPolicyResourceType,
} from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

/**
 * Depot mark, taken verbatim from the logomark depot.dev ships in its site
 * header (`<svg viewBox="0 0 64 64">`, October 2026; the same shape as
 * https://depot.dev/favicon-light/favicon.svg at 512 units), filled white on
 * the near-black #080808 the light favicon uses. scale(0.875) +
 * translate(22,22) centres the 64-unit glyph at 56% of the tile.
 */
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="12" fill="#080808"/>
  <g transform="translate(22,22) scale(0.875)" fill="#ffffff">
    <path d="M64 54.8574H45.7139C43.4923 54.8576 41.5177 55.9148 40.2637 57.5527C40.2607 57.5603 40.256 57.5662 40.25 57.5723C40.2287 57.5997 40.2073 57.6278 40.1875 57.6553L40.1797 57.6592C37.7203 60.9003 34.0572 63.1789 29.8516 63.8174C29.0623 63.9378 28.253 64 27.4287 64H0V54.8574H22.8574C23.6817 54.8574 24.491 54.7942 25.2803 54.6738C29.4858 54.0353 33.149 51.7577 35.6084 48.5166L35.6162 48.5117C35.636 48.4844 35.6575 48.457 35.6787 48.4297C35.6847 48.4237 35.6894 48.4177 35.6924 48.4102C36.9464 46.7721 38.921 45.714 41.1426 45.7139H64V54.8574ZM21.333 36.5723C24.7174 36.5723 27.6727 38.4114 29.2529 41.1436C27.6727 43.8757 24.7174 45.7148 21.333 45.7148H0V36.5723H21.333ZM27.4287 18.2842C28.253 18.2842 29.0623 18.3464 29.8516 18.4668C34.0572 19.1053 37.7203 21.3839 40.1797 24.625L40.1875 24.6289C40.2073 24.6563 40.2287 24.6845 40.25 24.7119C40.256 24.718 40.2607 24.7239 40.2637 24.7314C41.5177 26.3694 43.4923 27.4266 45.7139 27.4268H64V36.5703H41.1426C38.921 36.5702 36.9464 35.5121 35.6924 33.874C35.6894 33.8665 35.6847 33.8605 35.6787 33.8545C35.6574 33.8271 35.636 33.7998 35.6162 33.7725L35.6084 33.7676C33.149 30.5265 29.4858 28.2489 25.2803 27.6104C24.491 27.49 23.6817 27.4268 22.8574 27.4268H0V18.2842H27.4287ZM36.5713 0C37.3956 0 38.2049 0.062254 38.9941 0.182617C43.1998 0.821091 46.8628 3.0997 49.3223 6.34082L49.3301 6.34473C49.3499 6.37216 49.3712 6.40031 49.3926 6.42773C49.3986 6.43379 49.4032 6.4397 49.4062 6.44727C50.6603 8.08536 52.6357 9.14258 54.8574 9.14258H64V18.2861H50.2861C48.0644 18.2861 46.0891 17.2279 44.835 15.5898C44.8319 15.5823 44.8273 15.5763 44.8213 15.5703C44.8 15.5429 44.7786 15.5157 44.7588 15.4883L44.751 15.4834C42.2916 12.2423 38.6285 9.96465 34.4229 9.32617C33.6335 9.20579 32.8244 9.14258 32 9.14258H0V0H36.5713Z"/>
  </g>
</svg>`;

const manifest: PluginManifest = {
  id: "depot",
  version: "0.1.0",
  displayName: "Depot",
  logoSvg,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "Organization Token",
      description:
        "An organization token from Depot: Organization Settings, API Tokens. It lists projects, builds, project tokens and trust relationships, and reads usage. Project tokens and user tokens cannot read usage.",
      sensitive: true,
      placeholder: "your-depot-organization-token",
      helpLink: {
        label: "Create an organization token",
        url: "https://depot.dev/orgs/_/settings",
      },
    },
    {
      key: "plan",
      label: "Depot Plan",
      description:
        "Depot's API reports usage but not your plan, so pick yours. Its fee and included minutes and storage drive the cost estimate. Update it when your plan changes.",
      sensitive: false,
      defaultValue: DEFAULT_PLAN_ID,
      regions: DEPOT_PLANS.map((p) => ({ id: p.id, label: p.label, location: p.summary })),
    },
    {
      key: "rateOverrides",
      label: "Rate Overrides (optional)",
      description:
        "Optional. Replace any published rate or allowance, one key=value per line or comma-separated: planFee, includedBuildMinutes, includedActionsMinutes, includedStorageGb (allowances); buildMinute (0.04), actionsMinute (0.006), macosMinute (0.08), sandboxMinute (0.01), storageGbMonth (0.20) in USD; cycleStartDay (1 to 28) if your billing cycle does not start on the 1st. Use it for a Business contract or a price change.",
      sensitive: false,
      optional: true,
      multiline: true,
      placeholder: "planFee=1000\nincludedBuildMinutes=30000\nbuildMinute=0.03\ncycleStartDay=15",
    },
    caCertCredentialField,
  ],
  /**
   * Estimated spend from `UsageService/GetUsage` (see `cost-data.ts`).
   *
   * `service` is the product (container builds, GitHub Actions runners,
   * macOS runners, cache and registry storage, agent sandboxes, the plan
   * fee); `resource` is the project for build minutes; `tag` carries
   * project, repo, workflow, runner, storage type and agent type, which is
   * how runner minutes are broken down by repository.
   *
   * `estimated: true`: Depot meters usage but has no billing API, so amounts
   * are quantities times the plan and rates on the account.
   *
   * `maxHistoryDays: 90` because the endpoint has no daily buckets: a day of
   * history is a request, and pricing a day against the included-minutes
   * pool means reading its cycle from the start too. `restatementDays: 2`
   * re-reads today (partial) and yesterday once they close.
   */
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 90,
    restatementDays: 2,
    estimated: true,
  },
  // Included build minutes, Actions minutes and storage for the plan on the
  // account, against the current billing cycle's usage.
  quotas: { label: "Plan allowances", increaseUrl: "https://depot.dev/pricing" },
  statusFeed,
};

const resourceTypes: ResourceTypeDefinition[] = [
  ProjectResourceType,
  BuildResourceType,
  TokenResourceType,
  TrustPolicyResourceType,
  RegistryImageResourceType,
  ActionsRepoResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new DepotClient(credentials, services),
  parseStatusFeed,
};

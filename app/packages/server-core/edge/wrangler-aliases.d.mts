/** Compare a wrangler.jsonc's `alias` map with `gateway-only-modules.json`. */
export function compareWranglerAliases(wranglerPath: string): {
  missing: string[];
  extra: string[];
};

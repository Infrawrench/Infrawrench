// `infrawrench tag-keys`: the tag keys the org's cost data and inventory
// carry, with which ones the org hides from its pickers and which it pins to
// the top; plus `hide`/`unhide`/`pin`/`unpin` to edit those lists.
//
// Writes are allowed here, unlike `billing-rules`: hiding a key changes what a
// picker offers and nothing else, no figure moves, and the server still
// audit-logs every save. The response schemas are checked against
// `@infrawrench/client-core` by `wire`, type-only, so the CLI keeps its
// zero-runtime-dependency rule; pattern validation is the server's (it
// answers a 400 naming the problem).
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { DiscoveredTagKeysResponse, TagKeySettings } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, safe } from "../output";

export type TagKeysAction = "hide" | "unhide" | "pin" | "unpin";

const Settings = wire<TagKeySettings>()(
  Schema.Struct({ hidden: Schema.Array(Schema.String), preferred: Schema.Array(Schema.String) }),
);
type Settings = typeof Settings.Type;

const Discovered = wire<DiscoveredTagKeysResponse>()(
  Schema.Struct({
    keys: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        providers: Schema.Array(Schema.String),
        costRowCount: Schema.Finite,
        costResourceCount: Schema.Finite,
        inventoryCount: Schema.Finite,
        lastSeen: Schema.NullOr(Schema.String),
        hidden: Schema.Boolean,
        hiddenBy: Schema.NullOr(Schema.String),
        preferred: Schema.Boolean,
      }),
    ),
    settings: Settings,
    lookbackDays: Schema.Finite,
    truncated: Schema.Boolean,
  }),
);
type DiscoveredKey = (typeof Discovered.Type)["keys"][number];

const TAG_KEYS_PATH = "/tag-keys";
const SETTINGS_PATH = "/tag-keys/settings";

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Tag key settings are org-level cloud state; there is nothing local to list.",
    });
  }
});

/** One row's status, in words. */
function statusText(k: DiscoveredKey): string {
  if (k.preferred) return c.cyan("preferred");
  if (k.hidden) {
    return k.hiddenBy && k.hiddenBy !== k.key
      ? c.dim(`hidden by ${safe(k.hiddenBy)}`)
      : c.dim("hidden");
  }
  return "visible";
}

const list = (values: ReadonlyArray<string>) => values.map(safe).join(", ");

/** Apply one edit to the settings document. Pure, exported for tests. */
export function editTagKeySettings(
  settings: Settings,
  action: TagKeysAction,
  value: string,
): TagKeySettings {
  const v = value.trim();
  const hidden = [...settings.hidden];
  const preferred = [...settings.preferred];
  switch (action) {
    case "hide":
      return {
        hidden: hidden.includes(v) ? hidden : [...hidden, v],
        preferred: preferred.filter((p) => p !== v),
      };
    case "unhide":
      return { hidden: hidden.filter((h) => h !== v), preferred };
    case "pin":
      return {
        hidden: hidden.filter((h) => h !== v),
        preferred: preferred.includes(v) ? preferred : [...preferred, v],
      };
    case "unpin":
      return { hidden, preferred: preferred.filter((p) => p !== v) };
  }
}

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** `infrawrench tag-keys hide|unhide|pin|unpin <key-or-pattern>`. */
const edit = (action: TagKeysAction, description: string) =>
  Command.make(
    action,
    {
      value: Argument.String(action === "hide" || action === "unhide" ? "key|prefix*" : "key").pipe(
        Argument.withDescription("The tag key (the words join into one key)"),
        Argument.variadic(),
      ),
    },
    Effect.fn(`tag-keys.${action}`)(function* (input) {
      yield* refuseLocal;
      const session = yield* CliSession;
      const api = yield* CloudApi;
      const value = input.value.join(" ");
      if (!value.trim()) {
        return yield* new CliFailure({
          message:
            action === "hide" || action === "unhide"
              ? `Usage: infrawrench tag-keys ${action} <key | prefix*>   e.g. 'aws:cloudformation:*'`
              : `Usage: infrawrench tag-keys ${action} <key>`,
        });
      }
      const org = yield* currentOrg;
      const currentBody = yield* api.json(org.id, SETTINGS_PATH);
      const current = yield* decodeBody(Settings, SETTINGS_PATH)(currentBody);
      const next = editTagKeySettings(current, action, value);
      const unchanged =
        sameList(next.hidden, current.hidden) && sameList(next.preferred, current.preferred);

      const savedBody = unchanged
        ? currentBody
        : yield* api.json(org.id, SETTINGS_PATH, { method: "PUT", body: JSON.stringify(next) });

      if (session.output === "json") {
        return yield* Print.json({ org: org.id, changed: !unchanged, settings: savedBody });
      }
      const saved = yield* decodeBody(Settings, SETTINGS_PATH)(savedBody);
      if (unchanged) {
        const was =
          action === "hide"
            ? "hidden"
            : action === "pin"
              ? "pinned"
              : `not ${action === "unhide" ? "hidden" : "pinned"}`;
        yield* Print.line(c.dim(`Nothing to change: ${safe(value.trim())} was already ${was}.`));
      }
      yield* Print.line(
        `${c.dim("preferred")} ${saved.preferred.length ? list(saved.preferred) : c.dim("none")}`,
      );
      yield* Print.line(
        `${c.dim("hidden   ")} ${saved.hidden.length ? list(saved.hidden) : c.dim("none")}`,
      );
    }),
  ).pipe(Command.withDescription(description));

/** `infrawrench tag-keys`: discovered keys with usage and status. */
export const tagKeys = Command.make(
  "tag-keys",
  {},
  Effect.fn("tag-keys")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, TAG_KEYS_PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, TAG_KEYS_PATH));
    }
    const res = yield* decodeBody(Discovered, TAG_KEYS_PATH)(body);

    const { settings } = res;
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim("· preferred")} ${
        settings.preferred.length ? c.bold(list(settings.preferred)) : c.dim("none")
      } ${c.dim("· hidden")} ${settings.hidden.length ? list(settings.hidden) : c.dim("none")}`,
    );
    yield* Print.line();
    yield* Print.table(res.keys, [
      {
        header: "key",
        value: (k) =>
          k.hidden ? c.dim(safe(k.key)) : k.preferred ? c.bold(safe(k.key)) : safe(k.key),
      },
      { header: "providers", value: (k) => k.providers.map(safe).join(",") || c.dim("—") },
      {
        header: "cost rows",
        value: (k) => k.costRowCount.toLocaleString("en-US"),
        align: "right",
      },
      {
        header: "resources",
        value: (k) => Math.max(k.costResourceCount, k.inventoryCount).toLocaleString("en-US"),
        align: "right",
      },
      { header: "last seen", value: (k) => (k.lastSeen ? safe(k.lastSeen) : c.dim("—")) },
      { header: "status", value: statusText },
    ]);
    yield* Print.line();
    yield* Print.line(
      c.dim(
        `Cost usage covers the last ${res.lookbackDays} days.` +
          (res.truncated ? ` Showing the ${res.keys.length} busiest keys.` : "") +
          " Hidden keys are only left out of pickers; their data is still queryable.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Every tag key in cost data and inventory, with providers, usage and whether it is hidden or pinned",
  ),
  Command.withSubcommands([
    edit(
      "hide",
      "Hide a key, or a prefix like 'aws:cloudformation:*', from every picker (data untouched)",
    ),
    edit("unhide", "Put a hidden key back in the pickers"),
    edit("pin", "Pin a key to the top of every picker"),
    edit("unpin", "Unpin a key"),
  ]),
);

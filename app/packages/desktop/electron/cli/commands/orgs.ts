// `infrawrench orgs`: the signed-in user's organizations.
import { Effect } from "effect";
import { Command } from "effect/cli";
import { CloudApi } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { c } from "../output";

export const orgs = Command.make(
  "orgs",
  {},
  Effect.fn("orgs")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const all = yield* api.listOrgs;
    if (session.output === "json") return yield* Print.json(all);
    yield* Print.table(all, [
      { header: "id", value: (o) => o.id },
      { header: "name", value: (o) => c.bold(o.displayName) },
      { header: "role", value: (o) => o.role },
    ]);
    yield* Print.line();
    yield* Print.line(c.dim("Plus the local workspace: use --local on any command."));
  }),
).pipe(Command.withDescription("List your organizations"));

import { Effect, Layer } from "effect";
import { LocalDatabaseRpcs } from "../../../shared/rpc/groups/local-database";
import { LocalDatabase } from "../../local-database";

export const LocalDatabaseHandlers = LocalDatabaseRpcs.toLayer(
  Effect.gen(function* () {
    const db = yield* LocalDatabase;
    return LocalDatabaseRpcs.of({
      LocalDbSelect: ({ sql, params }) => db.select(sql, params),
      LocalDbExecute: ({ sql, params }) => db.execute(sql, params),
    });
  }),
).pipe(Layer.provide(LocalDatabase.layer));

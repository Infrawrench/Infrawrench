import { Effect, Layer } from "effect";
import { LocalDnsRpcs } from "../../../shared/rpc/groups/local-dns";
import { LocalDns } from "../../local-dns";

export const LocalDnsHandlers = LocalDnsRpcs.toLayer(
  Effect.gen(function* () {
    const dns = yield* LocalDns;
    return LocalDnsRpcs.of({ LocalDnsInventory: () => dns.inventory });
  }),
).pipe(Layer.provide(LocalDns.layer));

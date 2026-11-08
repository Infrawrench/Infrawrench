/**
 * DNS inventory: `/api/org/:orgId/dns`, the handlers.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { listDns } from "@infrawrench/server-core/dns/feed";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { DnsApi, DnsInventoryResponse } from "./api";

const DnsHandlers = HttpApiBuilder.group(DnsApi, "dns", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const inventory = yield* legacy(() => listDns(organizationId));
      return yield* respond(DnsInventoryResponse)(inventory);
    }),
  ),
);

export const dnsDomain = makeDomain("dns", DnsApi, DnsHandlers);

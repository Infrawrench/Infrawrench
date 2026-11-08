/**
 * The receiving end of the cross-replica relay, `POST /api/internal/relay`,
 * the endpoint definition.
 *
 * Pod-to-pod: authenticated by `INTERNAL_RELAY_SECRET` and nothing else (the
 * handler's header comment says why that is the whole check), and so outside
 * every auth middleware. Never in the published spec, as the Hono route was
 * not. The body is read and checked by the handler (`handleRaw`), since a
 * call is refused on its secret before its body is even parsed.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { withApiDefaults } from "../../domain";
import { BadRequest, Unauthorized, UnprocessableEntity } from "../../errors";

export class InternalRelayGroup extends HttpApiGroup.make("internalRelay")
  .add(
    HttpApiEndpoint.post("relay", "/api/internal/relay", {
      success: Schema.Unknown,
      error: [BadRequest, Unauthorized, UnprocessableEntity],
    }),
  )
  .annotate(OpenApi.Exclude, true) {}

export class InternalRelayApi extends withApiDefaults(
  HttpApi.make("internalRelay").add(InternalRelayGroup),
) {}

/**
 * The API's own documentation, the handlers. `/openapi.json` is the public
 * document: internal routes (platform admin, webhooks, browser auth, desktop
 * sync, ws-token, push) and the `sessionCookie` scheme are stripped from it
 * (`api/openapi/public-spec.ts`), and SDK code samples are added.
 *
 * The document builder is imported on use: it imports `DOMAINS`, which lists
 * this domain.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ApiDocsApi } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { REFERENCE_PAGE } from "./reference-page";

const ApiDocsHandlers = HttpApiBuilder.group(ApiDocsApi, "apiDocs", (handlers) =>
  handlers
    .handleRaw("openapi", () =>
      legacy(async () => {
        const { getPublicOpenApiDocument } = await import("../../../api/openapi/index");
        return getPublicOpenApiDocument();
      }).pipe(Effect.map((document) => HttpServerResponse.jsonUnsafe(document))),
    )
    .handleRaw("reference", () =>
      Effect.succeed(
        HttpServerResponse.text(REFERENCE_PAGE, { contentType: "text/html; charset=UTF-8" }),
      ),
    ),
);

export const apiDocsDomain = makeDomain("api-docs", ApiDocsApi, ApiDocsHandlers);

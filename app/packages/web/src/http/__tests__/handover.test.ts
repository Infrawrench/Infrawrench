/**
 * What the HttpApi handler does to a request on its way in and out, beyond
 * what any one domain sees:
 *
 * - a request no domain routes, whatever its content type, gets the
 *   `404 Not Found` text the API has always sent, with the security headers;
 * - a handler is not interrupted when the client goes away, as the Hono
 *   handlers were not: interrupting between two steps of a write leaves it
 *   half done;
 * - HEAD is the GET route minus its body.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { makeDomain, withApiDefaults } from "@/http/domain";
import { legacy } from "@/http/legacy";
import { makeHttpApiHandler } from "@/http/server";
import { testMiddleware } from "@/http/testing";

const steps: string[] = [];
const firstStepStarted = Deferred.makeUnsafe<void>();
let releaseFirstStep: () => void = () => {};

const Group = HttpApiGroup.make("handover").add(
  HttpApiEndpoint.post("twoSteps", "/api/handover/two-steps", { success: Schema.String }),
  HttpApiEndpoint.get("greeting", "/api/handover/greeting", { success: Schema.String }),
);
class HandoverApi extends withApiDefaults(HttpApi.make("handover").add(Group)) {}
const domain = makeDomain(
  "handover",
  HandoverApi,
  HttpApiBuilder.group(HandoverApi, "handover", (h) =>
    h
      .handle("twoSteps", () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(firstStepStarted, undefined);
          yield* legacy(
            () =>
              new Promise<void>((resolve) => {
                releaseFirstStep = resolve;
              }),
          );
          steps.push("first");
          yield* legacy(async () => {
            steps.push("second");
          });
          return "done";
        }),
      )
      .handle("greeting", () => Effect.succeed("hello")),
  ),
);

const handler = makeHttpApiHandler([domain], testMiddleware());
const app = {
  request: (path: string, init?: RequestInit) =>
    handler.handle(new Request(`http://localhost${path}`, init)),
};

describe("the HttpApi handler", () => {
  it("answers a request no domain routes with the 404 it always sent", async () => {
    for (const type of ["application/x-www-form-urlencoded", "text/plain;charset=UTF-8"]) {
      const res = await app.request("/api/handover/unrouted", {
        method: "POST",
        headers: { "content-type": type },
        body: "token=abc&text=%2Fdeploy",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(await res.text()).toBe("404 Not Found");
    }
  });

  it("runs a handler to its end when the client goes away mid-request", async () => {
    steps.length = 0;
    const client = new AbortController();
    const pending = Promise.resolve(
      app.request("/api/handover/two-steps", { method: "POST", signal: client.signal }),
    ).catch(() => undefined);
    await Effect.runPromise(Deferred.await(firstStepStarted));
    client.abort();
    releaseFirstStep();
    await pending;
    // Give the handler's remaining steps a moment to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steps).toEqual(["first", "second"]);
  });

  it("answers HEAD with the GET route's status and headers and no body, as Hono did", async () => {
    const get = await app.request("/api/handover/greeting");
    const head = await app.request("/api/handover/greeting", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
  });

  it("answers HEAD on a path nothing routes with the 404's headers and no body", async () => {
    const head = await app.request("/api/handover/unrouted", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(head.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await head.text()).toBe("");
  });
});

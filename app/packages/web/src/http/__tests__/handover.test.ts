/**
 * How a request crosses from Hono to the HttpApi router and back:
 *
 * - a request no domain routes reaches Hono with its body unread, even under a
 *   content type the router would have rewritten (a signed form post such as
 *   Slack's must verify against the bytes it was sent);
 * - a handler is not interrupted when the client goes away, as Hono's were
 *   not: interrupting between two steps of a write leaves it half done.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Hono } from "hono";
import { makeDomain, withApiDefaults } from "@/http/domain";
import { legacy } from "@/http/legacy";
import { httpApiMiddleware, makeHttpApiHandler } from "@/http/server";
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

const app = new Hono();
app.use("*", httpApiMiddleware(makeHttpApiHandler([domain], testMiddleware())));
app.post("/api/legacy/echo", async (c) => c.text(await c.req.text()));

describe("the Hono to HttpApi handover", () => {
  it("leaves a request no domain routes, body and all, to Hono", async () => {
    for (const type of ["application/x-www-form-urlencoded", "text/plain;charset=UTF-8"]) {
      const res = await app.request("/api/legacy/echo", {
        method: "POST",
        headers: { "content-type": type },
        body: "token=abc&text=%2Fdeploy",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("token=abc&text=%2Fdeploy");
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
});

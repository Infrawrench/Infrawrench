import { describe, expect, it } from "vitest";
import { lambdaInvocation } from "../runtime/lambda";
import { dbWritesInScope, keepAlive, sessionHandoffInScope } from "../runtime/request-scope";

describe("lambdaInvocation", () => {
  it("drains keepAlive work, including work started while draining", async () => {
    const done: string[] = [];
    const invocation = lambdaInvocation();
    await invocation.run(async () => {
      void keepAlive(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            done.push("first");
            // Registered from inside kept-alive work, after the drain began.
            void keepAlive(
              new Promise<void>((r) =>
                setTimeout(() => {
                  done.push("second");
                  r();
                }, 5),
              ),
            );
            resolve();
          }, 5),
        ),
      );
    });
    expect(done).toEqual([]);
    await invocation.drain();
    expect(done).toEqual(["first", "second"]);
  });

  it("survives kept-alive work that rejects", async () => {
    const invocation = lambdaInvocation();
    await invocation.run(async () => {
      keepAlive(Promise.reject(new Error("audit write failed"))).catch(() => {});
    });
    await expect(invocation.drain()).resolves.toBeUndefined();
  });

  it("opts into the session handoff only when asked", async () => {
    expect(await lambdaInvocation().run(async () => sessionHandoffInScope())).toBe(false);
    expect(
      await lambdaInvocation({ sessionHandoff: true }).run(async () => sessionHandoffInScope()),
    ).toBe(true);
    expect(sessionHandoffInScope()).toBe(false);
  });

  it("gives each invocation its own write counter", async () => {
    expect(await lambdaInvocation().run(async () => dbWritesInScope())).toBe(0);
  });
});

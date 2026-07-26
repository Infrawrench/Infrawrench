import { describe, expect, it, vi } from "vitest";

import {
  dispatch,
  WorkflowCapabilityError,
  type WorkflowHost,
  type WorkflowRunContext,
} from "./host.js";
import {
  DEFAULT_PAGE_COOLDOWN_MINUTES,
  DEFAULT_PAGE_KEY,
  type PageResult,
  type PageSpec,
} from "./types.js";

/**
 * `infra.page` defaults are applied in dispatch rather than in the prelude, so
 * every host — cloud, desktop, and anything added later — sees the same
 * normalized spec. These lock that contract down.
 */

const OK: PageResult = { delivered: true, suppressed: false, sms: 1, push: 2, slack: 1 };

const ctx: WorkflowRunContext = {
  interactive: false,
  log: () => {},
  setOutput: () => {},
};

function hostWithPage(page = vi.fn(async (_spec: PageSpec) => OK)) {
  return { host: { page } as unknown as WorkflowHost, page };
}

describe("page dispatch", () => {
  it("applies the default key and cooldown", async () => {
    const { host, page } = hostWithPage();
    await dispatch(host, ctx, "page", { spec: { message: "disk is full" } });
    expect(page).toHaveBeenCalledWith({
      message: "disk is full",
      key: DEFAULT_PAGE_KEY,
      cooldownMinutes: DEFAULT_PAGE_COOLDOWN_MINUTES,
    });
  });

  it("passes through an explicit key, cooldown, title, and voice", async () => {
    const { host, page } = hostWithPage();
    await dispatch(host, ctx, "page", {
      spec: {
        message: "api-7 restarted 9 times",
        title: "Pod restarts",
        key: "api-7",
        cooldownMinutes: 15,
        voice: true,
      },
    });
    expect(page).toHaveBeenCalledWith({
      message: "api-7 restarted 9 times",
      title: "Pod restarts",
      key: "api-7",
      cooldownMinutes: 15,
      voice: true,
    });
  });

  it("treats cooldownMinutes: 0 as 'send every time'", async () => {
    const { host, page } = hostWithPage();
    await dispatch(host, ctx, "page", { spec: { message: "tick", cooldownMinutes: 0 } });
    expect(page.mock.calls[0]?.[0]).toMatchObject({ cooldownMinutes: 0 });
  });

  it("rejects a blank message rather than sending an unactionable page", async () => {
    const { host, page } = hostWithPage();
    await expect(dispatch(host, ctx, "page", { spec: { message: "   " } })).rejects.toThrow(
      /needs a message/,
    );
    expect(page).not.toHaveBeenCalled();
  });

  it("surfaces a capability error on a host that cannot page", async () => {
    await expect(
      dispatch({} as WorkflowHost, ctx, "page", { spec: { message: "hi" } }),
    ).rejects.toBeInstanceOf(WorkflowCapabilityError);
  });

  it("clears the default key when page.clear() is called with no argument", async () => {
    const clearPage = vi.fn(async () => {});
    await dispatch({ clearPage } as unknown as WorkflowHost, ctx, "page.clear", {});
    expect(clearPage).toHaveBeenCalledWith(DEFAULT_PAGE_KEY);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  get_explicit_consent_status: vi.fn(() => "pending"),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

const fetchTrace = vi.fn(async () => new Response("loc=US\n"));

/** The module keeps per-page state, so each test loads a fresh copy. */
async function load() {
  vi.resetModules();
  return import("../index");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", fetchTrace);
});

describe("cookieless surfaces", () => {
  it("run PostHog without storage or replay", async () => {
    const { initAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: "phc_test", cookieless: true });
    await analyticsLoaded();
    expect(posthog.init.mock.calls[0]![1]).toMatchObject({
      cookieless_mode: "always",
      disable_session_recording: true,
    });
  });

  it("never look up the visitor's region, opt them in or show the prompt", async () => {
    const { initAnalytics, consentPromptVisible } = await load();
    initAnalytics({ key: "phc_test", cookieless: true });
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    expect(fetchTrace).not.toHaveBeenCalled();
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(consentPromptVisible()).toBe(false);
  });

  it("capture events without a consent answer", async () => {
    const { initAnalytics, captureAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: "phc_test", cookieless: true });
    captureAnalytics("clicked", { target: "x" });
    await analyticsLoaded();
    expect(posthog.capture).toHaveBeenCalledWith("clicked", { target: "x" });
  });

  it("register properties for every event", async () => {
    const { initAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: "phc_test", cookieless: true, properties: { framed: true } });
    await analyticsLoaded();
    expect(posthog.register).toHaveBeenCalledWith({ framed: true });
  });

  it("queue events sent before the SDK has loaded, and send them once it has", async () => {
    const { initAnalytics, captureAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: "phc_test", cookieless: true });
    captureAnalytics("early");
    expect(posthog.capture).not.toHaveBeenCalled();
    await analyticsLoaded();
    expect(posthog.capture).toHaveBeenCalledWith("early", {});
  });

  it("do nothing without a key", async () => {
    const { initAnalytics, captureAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: undefined, cookieless: true });
    captureAnalytics("clicked");
    await analyticsLoaded();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});

describe("ordinary surfaces", () => {
  it("keep the consent flow and allow replay", async () => {
    const { initAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: "phc_test" });
    await analyticsLoaded();
    expect(posthog.init.mock.calls[0]![1]).toMatchObject({
      cookieless_mode: "on_reject",
      disable_session_recording: false,
    });
    await vi.waitFor(() => expect(fetchTrace).toHaveBeenCalled());
  });

  it("drop events until consent is granted", async () => {
    const { initAnalytics, captureAnalytics, analyticsLoaded } = await load();
    initAnalytics({ key: "phc_test" });
    captureAnalytics("clicked");
    await analyticsLoaded();
    expect(posthog.capture).not.toHaveBeenCalled();
    posthog.get_explicit_consent_status.mockReturnValue("granted");
    captureAnalytics("clicked");
    expect(posthog.capture).toHaveBeenCalledOnce();
  });
});

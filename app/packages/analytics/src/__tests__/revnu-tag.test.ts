import { beforeEach, describe, expect, it, vi } from "vitest";

const ANON = `ra_${"ab".repeat(16)}`;

let status = "pending";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    get_explicit_consent_status: () => status,
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    get_distinct_id: () => "",
  },
}));
vi.mock("../region", () => ({ visitorNeedsConsent: async () => true }));

type FakeScript = {
  src: string;
  async: boolean;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (name: string, listener: () => void) => void;
  load: () => void;
};

/** A fresh module per test: the "tag requested" flag and PostHog state are per page. */
async function page(options: { path?: string; host?: string; referrer?: string; key?: string }) {
  vi.resetModules();
  const scripts: FakeScript[] = [];
  const cookies: string[] = [];
  const listeners: Array<() => void> = [];
  const location = {
    pathname: options.path ?? "/org/org-1",
    hostname: options.host ?? "app.infrawrench.com",
    protocol: "https:",
    origin: `https://${options.host ?? "app.infrawrench.com"}`,
  };
  const history = {
    pushState(_data: unknown, _title: string, url: string) {
      location.pathname = url;
    },
    replaceState(_data: unknown, _title: string, url: string) {
      location.pathname = url;
    },
  };
  const removed: string[] = [];
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: (key: string) => removed.push(key),
  };
  const win = {
    location,
    history,
    localStorage: storage,
    sessionStorage: storage,
    addEventListener: (_name: string, listener: () => void) => listeners.push(listener),
    revnu: undefined as undefined | { consent: ReturnType<typeof vi.fn>; anonymousId?: string },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    referrer: options.referrer ?? "",
    get cookie() {
      return "";
    },
    set cookie(value: string) {
      cookies.push(value);
    },
    head: { appendChild: (script: FakeScript) => scripts.push(script) },
    createElement: () => {
      let onLoad = () => {};
      const script: FakeScript = {
        src: "",
        async: false,
        attributes: {},
        setAttribute(name, value) {
          script.attributes[name] = value;
        },
        addEventListener: (_name, listener) => {
          onLoad = listener;
        },
        load: () => onLoad(),
      };
      return script;
    },
  });
  const analytics = await import("../index");
  analytics.initAnalytics({
    key: options.key === undefined ? "phc_test" : options.key || undefined,
  });
  return { analytics, scripts, cookies, win, removed };
}

describe("bindRevnuToAnalyticsConsent", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    status = "pending";
  });

  it("adds nothing to the page until consent is granted", async () => {
    const { analytics, scripts } = await page({});
    analytics.bindRevnuToAnalyticsConsent();
    expect(scripts).toEqual([]);
  });

  it("adds nothing without a PostHog key, even though nobody can be asked", async () => {
    status = "granted";
    const { analytics, scripts } = await page({ key: "" });
    analytics.bindRevnuToAnalyticsConsent();
    expect(scripts).toEqual([]);
  });

  it("loads the tag asynchronously once granted, and only once", async () => {
    status = "granted";
    const { analytics, scripts } = await page({});
    analytics.bindRevnuToAnalyticsConsent();
    analytics.bindRevnuToAnalyticsConsent();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({ src: "https://revnu.com/v1.js", async: true });
    expect(scripts[0]?.attributes["data-consent"]).toBe("granted");
  });

  it("does not load on a host other than ours", async () => {
    status = "granted";
    const { analytics, scripts } = await page({ host: "preview.example.com" });
    analytics.bindRevnuToAnalyticsConsent();
    expect(scripts).toEqual([]);
  });

  it("does not load on a held path, or on a page reached from one", async () => {
    status = "granted";
    const holdPath = (path: string) => path.startsWith("/share/");
    const held = await page({ path: "/share/secret" });
    held.analytics.bindRevnuToAnalyticsConsent({ holdPath });
    expect(held.scripts).toEqual([]);

    const after = await page({
      path: "/org/org-1",
      referrer: "https://app.infrawrench.com/share/secret",
    });
    after.analytics.bindRevnuToAnalyticsConsent({ holdPath });
    expect(after.scripts).toEqual([]);
  });

  it("suspends a running tag before it can see a client-side move onto a held path", async () => {
    status = "granted";
    const { analytics, win } = await page({});
    const consent = vi.fn();
    win.revnu = { consent, anonymousId: ANON };
    analytics.bindRevnuToAnalyticsConsent({ holdPath: (path) => path.startsWith("/share/") });
    consent.mockClear();

    win.history.pushState(null, "", "/share/secret");
    expect(consent).toHaveBeenCalledWith("pending");

    win.history.pushState(null, "", "/org/org-1");
    expect(consent).toHaveBeenLastCalledWith("granted");
  });

  it("reports the visitor id once the tag has loaded and copies it to the parent domain", async () => {
    status = "granted";
    const { analytics, scripts, cookies, win } = await page({});
    const onChange = vi.fn();
    analytics.bindRevnuToAnalyticsConsent({ onChange });
    win.revnu = { consent: vi.fn(), anonymousId: ANON };
    scripts[0]?.load();
    expect(onChange).toHaveBeenLastCalledWith({ consentState: "granted", anonymousId: ANON });
    expect(cookies.some((cookie) => cookie.includes(`revnu_aid=${ANON}; Domain=`))).toBe(true);
  });

  it("clears the stored visitor on a page that never loaded the tag", async () => {
    status = "denied";
    const { analytics, scripts, cookies, removed } = await page({});
    analytics.bindRevnuToAnalyticsConsent();
    expect(scripts).toEqual([]);
    expect(cookies).toContain("revnu_aid=; path=/; max-age=0; SameSite=Lax; Secure");
    expect(removed).toContain("revnu_aid");
  });
});

describe("readRevnuMeasurement", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a decline even when the tag is absent", async () => {
    status = "denied";
    const { analytics } = await page({});
    expect(analytics.readRevnuMeasurement()).toEqual({ consentState: "denied" });
  });

  it("only sends the visitor id after a grant", async () => {
    status = "pending";
    const pending = await page({});
    pending.win.revnu = { consent: vi.fn(), anonymousId: ANON };
    expect(pending.analytics.readRevnuMeasurement()).toEqual({ consentState: "pending" });

    status = "granted";
    const granted = await page({});
    granted.win.revnu = { consent: vi.fn(), anonymousId: ANON };
    expect(granted.analytics.readRevnuMeasurement()).toEqual({
      consentState: "granted",
      anonymousId: ANON,
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installCookieStoreShim } from "../cookie-store-shim.js";

/**
 * Stand in for the packaged renderer's file:// origin: writes are accepted and
 * silently discarded, which is what Chromium does there.
 */
function makeCookielessDocument() {
  const doc = {} as Document;
  Object.defineProperty(doc, "cookie", {
    configurable: true,
    get: () => "",
    set: () => {},
  });
  return doc;
}

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  } as Storage;
}

const globals = globalThis as { document?: Document; localStorage?: Storage };
let savedDocument: Document | undefined;
let savedStorage: Storage | undefined;

beforeEach(() => {
  savedDocument = globals.document;
  savedStorage = globals.localStorage;
  globals.document = makeCookielessDocument();
  globals.localStorage = makeMemoryStorage();
});

afterEach(() => {
  // These tests run under the node environment, so there is usually nothing to
  // put back — delete rather than assign undefined (exactOptionalPropertyTypes).
  if (savedDocument) globals.document = savedDocument;
  else delete globals.document;
  if (savedStorage) globals.localStorage = savedStorage;
  else delete globals.localStorage;
});

describe("installCookieStoreShim", () => {
  it("makes cookies readable back on an origin that drops them", () => {
    // The bug: without the shim a write vanishes, so gt-react falls back to
    // navigator.languages and the language picker appears to do nothing.
    document.cookie = "generaltranslation.locale=es;path=/";
    expect(document.cookie).toBe("");

    expect(installCookieStoreShim()).toBe(true);

    document.cookie = "generaltranslation.locale=es;path=/";
    expect(document.cookie).toContain("generaltranslation.locale=es");
  });

  it("survives a reload — the value comes back from localStorage", () => {
    installCookieStoreShim();
    document.cookie = "generaltranslation.locale=ja;path=/";

    // Reload: a fresh document, same storage.
    globals.document = makeCookielessDocument();
    installCookieStoreShim();

    expect(document.cookie).toContain("generaltranslation.locale=ja");
  });

  it("keeps several cookies apart and overwrites by name", () => {
    installCookieStoreShim();
    document.cookie = "a=1;path=/";
    document.cookie = "b=2;path=/";
    document.cookie = "a=3;path=/";

    expect(document.cookie).toBe("a=3; b=2");
  });

  it("honours deletion so a cleared cookie does not come back", () => {
    installCookieStoreShim();
    document.cookie = "generaltranslation.locale=fr;path=/";

    document.cookie = "generaltranslation.locale=;path=/;max-age=0";
    expect(document.cookie).not.toContain("generaltranslation.locale");

    document.cookie = "other=1;path=/";
    document.cookie = "other=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(document.cookie).toBe("");
  });

  it("stays out of the way where cookies already work", () => {
    // Dev serves the renderer over http://localhost, where the platform jar is
    // real; shimming there would shadow a working implementation.
    let stored = "";
    Object.defineProperty(globals.document!, "cookie", {
      configurable: true,
      get: () => stored,
      set: (v: string) => {
        stored = String(v).split(";")[0] ?? "";
      },
    });

    expect(installCookieStoreShim()).toBe(false);
  });
});

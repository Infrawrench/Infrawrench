import { describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * `/openapi.json` and `/docs`. The page is pinned byte for byte to what
 * `@scalar/hono-api-reference` rendered for this configuration when the route
 * moved off Hono: the pinned bundle reads exactly this config shape.
 */

const document = { openapi: "3.1.0", info: { title: "Infrawrench API" }, paths: {} };
const mockGetPublic = vi.fn(async () => document);
vi.mock("@/api/openapi/index", () => ({ getPublicOpenApiDocument: () => mockGetPublic() }));

const { apiDocsDomain } = await import("@/http/domains/api-docs/index");

const app = buildTestApi(apiDocsDomain);

const SCALAR_PAGE =
  '<!doctype html>\n<html>\n  <head>\n    <title>Infrawrench API</title>\n    <meta charset="utf-8" />\n    <meta\n      name="viewport"\n      content="width=device-width, initial-scale=1" />\n  </head>\n  <body>\n    <div id="app"></div>\n    <!-- Load the Script -->\n    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.63.0"></script>\n\n    <!-- Initialize the Scalar API Reference -->\n    <script type="text/javascript">\n      Scalar.createApiReference(\'#app\', {\n        "_integration": "hono",\n        "url": "/openapi.json",\n        "defaultHttpClient": {\n          "targetKey": "shell",\n          "clientKey": "curl"\n        },\n        "hiddenClients": {\n          "c": true,\n          "clojure": true,\n          "csharp": true,\n          "dart": true,\n          "http": true,\n          "java": true,\n          "kotlin": true,\n          "objc": true,\n          "ocaml": true,\n          "php": true,\n          "powershell": true,\n          "r": true,\n          "ruby": true,\n          "swift": true,\n          "shell": [\n            "httpie",\n            "wget"\n          ],\n          "js": [\n            "axios",\n            "jquery",\n            "ofetch",\n            "xhr"\n          ],\n          "node": [\n            "axios",\n            "ofetch",\n            "undici"\n          ],\n          "python": [\n            "python3"\n          ]\n        },\n        "theme": "default"\n      })\n    </script>\n  </body>\n</html>';

describe("API documentation", () => {
  it("serves the public document as JSON", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(JSON.stringify(document));
  });

  it("renders the Scalar page exactly as the Hono integration did", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toBe(SCALAR_PAGE);
  });
});

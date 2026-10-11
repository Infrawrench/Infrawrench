import { describe, expect, it, vi } from "vitest";
import {
  eventToRequest,
  handleLambdaRequest,
  hasGatewaySecret,
  responseMetadata,
  type FunctionUrlEvent,
  type LambdaApiDeps,
} from "../handle-request";
import { GATEWAY_SECRET_HEADER, SESSION_HANDOFF_HEADER } from "../protocol";

const SECRET = "s3cret-value";

function event(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: "/api/org/org_1/accounts/acc_1/resources",
    rawQueryString: "type=vm&page=2",
    headers: {
      "x-forwarded-host": "app.example.com",
      [GATEWAY_SECRET_HEADER]: SECRET,
    },
    requestContext: { domainName: "abc.lambda-url.us-east-2.on.aws", http: { method: "GET" } },
    ...overrides,
  };
}

function deps(overrides: Partial<LambdaApiDeps> = {}): LambdaApiDeps & {
  apiFetch: ReturnType<typeof vi.fn>;
} {
  return {
    secret: SECRET,
    apiFetch: vi.fn(async (req: Request) =>
      Response.json({ url: req.url, secret: req.headers.get(GATEWAY_SECRET_HEADER) }),
    ),
    accountNeedsSession: vi.fn(async () => false),
    gatewayOnlyHit: () => undefined,
    dbWrites: () => 0,
    waitUntil: () => {},
    ...overrides,
  } as never;
}

describe("eventToRequest", () => {
  it("rebuilds the public URL from the forwarded host", () => {
    const req = eventToRequest(event());
    expect(req.url).toBe(
      "https://app.example.com/api/org/org_1/accounts/acc_1/resources?type=vm&page=2",
    );
    expect(req.method).toBe("GET");
  });

  it("falls back to the function URL host when nothing was forwarded", () => {
    const req = eventToRequest(event({ headers: {}, rawQueryString: "" }));
    expect(req.url).toBe(
      "https://abc.lambda-url.us-east-2.on.aws/api/org/org_1/accounts/acc_1/resources",
    );
  });

  it("puts the cookies function URLs split out back into one header", () => {
    const req = eventToRequest(event({ cookies: ["a=1", "wos-session=xyz"] }));
    expect(req.headers.get("cookie")).toBe("a=1; wos-session=xyz");
  });

  it("decodes a base64 body and passes a text body through", async () => {
    const binary = eventToRequest(
      event({
        requestContext: { http: { method: "POST" } },
        body: Buffer.from([0, 1, 2, 255]).toString("base64"),
        isBase64Encoded: true,
      }),
    );
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));

    const text = eventToRequest(
      event({ requestContext: { http: { method: "post" } }, body: '{"a":1}' }),
    );
    expect(text.method).toBe("POST");
    expect(await text.json()).toEqual({ a: 1 });
  });
});

describe("hasGatewaySecret", () => {
  it("admits only the exact secret, and nothing when none is configured", () => {
    const req = (value?: string) =>
      new Request("https://x/", value ? { headers: { [GATEWAY_SECRET_HEADER]: value } } : {});
    expect(hasGatewaySecret(req(SECRET), SECRET)).toBe(true);
    expect(hasGatewaySecret(req("s3cret-valuX"), SECRET)).toBe(false);
    expect(hasGatewaySecret(req("short"), SECRET)).toBe(false);
    expect(hasGatewaySecret(req(), SECRET)).toBe(false);
    expect(hasGatewaySecret(req(SECRET), undefined)).toBe(false);
    expect(hasGatewaySecret(req(""), "")).toBe(false);
  });
});

describe("responseMetadata", () => {
  it("moves every set-cookie into the cookies array", () => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; HttpOnly");
    const meta = responseMetadata(new Response("{}", { status: 201, headers }));
    expect(meta).toEqual({
      statusCode: 201,
      headers: { "content-type": "application/json" },
      cookies: ["a=1; Path=/", "b=2; HttpOnly"],
    });
  });
});

describe("handleLambdaRequest", () => {
  it("refuses a request that did not come through the edge", async () => {
    const d = deps();
    const res = await handleLambdaRequest(eventToRequest(event({ headers: {} })), d);
    expect(res.status).toBe(403);
    expect(d.apiFetch).not.toHaveBeenCalled();
  });

  it("runs the API without the secret header", async () => {
    const d = deps();
    const res = await handleLambdaRequest(eventToRequest(event()), d);
    expect(await res.json()).toEqual({
      url: "https://app.example.com/api/org/org_1/accounts/acc_1/resources?type=vm&page=2",
      secret: null,
    });
  });

  it("hands a bastion-bound account back without running the API", async () => {
    const d = deps({ accountNeedsSession: vi.fn(async () => true) });
    const res = await handleLambdaRequest(eventToRequest(event()), d);
    expect(res.status).toBe(421);
    expect(res.headers.get(SESSION_HANDOFF_HEADER)).toBeTruthy();
    expect(d.apiFetch).not.toHaveBeenCalled();
  });

  it("hands back a session-only route a stale Worker sent here", async () => {
    const d = deps();
    const res = await handleLambdaRequest(
      eventToRequest(event({ rawPath: "/api/org/org_1/shared-consoles/abc", rawQueryString: "" })),
      d,
    );
    expect(res.status).toBe(421);
    expect(d.apiFetch).not.toHaveBeenCalled();
  });

  it("hands back work that reached process-local state before writing", async () => {
    const d = deps({ gatewayOnlyHit: () => "Routing through a bastion agent" });
    const res = await handleLambdaRequest(eventToRequest(event()), d);
    expect(res.status).toBe(421);
    expect(res.headers.get(SESSION_HANDOFF_HEADER)).toBe("process-local state");
  });

  it("answers 503 when that happened after a write, rather than replaying it", async () => {
    let writes = 0;
    const d = deps({
      apiFetch: vi.fn(async () => {
        writes++;
        return Response.json({ ok: true });
      }),
      gatewayOnlyHit: () => "Routing through a bastion agent",
      dbWrites: () => writes,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleLambdaRequest(
      eventToRequest(
        event({
          rawPath: "/api/org/org_1/resources/res_1/actions",
          rawQueryString: "",
          requestContext: { http: { method: "POST" } },
          body: "{}",
        }),
      ),
      d,
    );
    warn.mockRestore();
    expect(res.status).toBe(503);
  });
});

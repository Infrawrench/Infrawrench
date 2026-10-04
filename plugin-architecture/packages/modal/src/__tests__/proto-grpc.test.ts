import { describe, expect, it } from "vitest";
import { ModalApiError, unary, unframe } from "../grpc.js";
import { ProtoMessage, ProtoWriter } from "../proto.js";
import { ctxWith, framed, makeHttp, withMap } from "./helpers.js";

describe("protobuf codec", () => {
  it("round-trips scalars, strings, nested messages and maps", () => {
    const bytes = withMap(
      new ProtoWriter()
        .string(1, "héllo")
        .int(2, 300)
        .int(3, -5, true)
        .int(4, true)
        .double(5, 12.5)
        .strings(6, ["a", "", "b"])
        .message(7, new ProtoWriter().string(1, "inner"))
        .timestamp(8, 1_700_000_000_123),
      9,
      { k1: "v1", k2: "v2" },
    ).finish();
    const m = new ProtoMessage(bytes);
    expect(m.string(1)).toBe("héllo");
    expect(m.uint(2)).toBe(300);
    expect(m.int(3)).toBe(-5);
    expect(m.bool(4)).toBe(true);
    expect(m.double(5)).toBe(12.5);
    expect(m.strings(6)).toEqual(["a", "", "b"]);
    expect(m.message(7)?.string(1)).toBe("inner");
    expect(m.timestampMs(8)).toBe(1_700_000_000_123);
    expect(m.stringMap(9)).toEqual({ k1: "v1", k2: "v2" });
  });

  it("skips proto3 defaults but keeps an explicit optional zero", () => {
    expect(new ProtoWriter().string(1, "").int(2, 0).finish()).toHaveLength(0);
    const m = new ProtoMessage(new ProtoWriter().int(7, 0, true).finish());
    expect(m.has(7)).toBe(true);
    expect(m.int(7)).toBe(0);
  });

  it("encodes the bytes protobuf specifies", () => {
    // From the encoding guide: field 1 = 150 is 08 96 01.
    expect([...new ProtoWriter().int(1, 150).finish()]).toEqual([0x08, 0x96, 0x01]);
    // Field 2 = "testing" is 12 07 74 65 73 74 69 6e 67.
    expect([...new ProtoWriter().string(2, "testing").finish()]).toEqual([
      0x12, 0x07, 0x74, 0x65, 0x73, 0x74, 0x69, 0x6e, 0x67,
    ]);
  });

  it("ignores unknown fields and returns defaults for absent ones", () => {
    const m = new ProtoMessage(new ProtoWriter().string(99, "future").finish());
    expect(m.string(1)).toBe("");
    expect(m.uint(2)).toBe(0);
    expect(m.message(3)).toBeUndefined();
  });

  it("rejects a truncated message", () => {
    expect(() => new ProtoMessage(Uint8Array.from([0x0a, 0x05, 0x61]))).toThrow(/truncated/);
  });
});

describe("gRPC framing", () => {
  it("splits a streamed body into messages", () => {
    const a = new ProtoWriter().string(1, "a").finish();
    const b = new ProtoWriter().string(1, "bb").finish();
    const parts = unframe(framed([a, b, new Uint8Array()]), "M");
    expect(parts.map((p) => new ProtoMessage(p).string(1))).toEqual(["a", "bb", ""]);
  });

  it("refuses a frame cut short", () => {
    const body = framed([new ProtoWriter().string(1, "abc").finish()]).subarray(0, 7);
    expect(() => unframe(body, "M")).toThrow(ModalApiError);
  });

  it("sends the method path, auth metadata and a framed request", async () => {
    const { http, calls } = makeHttp(() => new ProtoWriter().string(2, "astrid"));
    const res = await unary(ctxWith(http), "WorkspaceNameLookup", new Uint8Array());
    expect(new ProtoMessage(res).string(2)).toBe("astrid");
    expect(calls[0]?.url).toBe(
      "https://api.modal.com/modal.client.ModalClient/WorkspaceNameLookup",
    );
    expect(calls[0]?.headers).toMatchObject({
      "content-type": "application/grpc",
      te: "trailers",
      "x-modal-token-id": "ak-test",
      "x-modal-token-secret": "as-test",
      "x-modal-host": "api.modal.com",
    });
  });

  it("turns a trailers-only error into a ModalApiError with the decoded message", async () => {
    const { http } = makeHttp(() => ({ grpcStatus: 16, message: "Token not found" }));
    await expect(unary(ctxWith(http), "AppList", new Uint8Array())).rejects.toMatchObject({
      name: "ModalApiError",
      code: 16,
      grpcMessage: "Token not found",
    });
  });

  it("refuses a non-gRPC response such as a proxy's HTML page", async () => {
    const { http } = makeHttp(() => ({ httpStatus: 200, contentType: "text/html" }));
    await expect(unary(ctxWith(http), "AppList", new Uint8Array())).rejects.toThrow(
      /unexpected response type/,
    );
  });
});

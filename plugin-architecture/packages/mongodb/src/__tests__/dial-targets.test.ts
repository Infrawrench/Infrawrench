import { describe, expect, it } from "vitest";
import { dialTargets } from "../driver.js";

describe("mongodb dialTargets", () => {
  it("reports every seed host", () => {
    expect(dialTargets("mongodb://u:p@a.example.com,b.example.com:27018/db?replicaSet=rs")).toEqual(
      [
        { kind: "host", host: "a.example.com", port: 27017 },
        { kind: "host", host: "b.example.com", port: 27018 },
      ],
    );
  });

  it("reports the SRV name of a mongodb+srv string", () => {
    expect(dialTargets("mongodb+srv://u:p@cluster0.example.net/db")).toEqual([
      { kind: "srv", name: "_mongodb._tcp.cluster0.example.net" },
    ]);
  });

  it("reports a percent-encoded socket path as local", () => {
    expect(dialTargets("mongodb://%2Ftmp%2Fmongodb-27017.sock/db")[0]!.kind).toBe("local");
  });
});

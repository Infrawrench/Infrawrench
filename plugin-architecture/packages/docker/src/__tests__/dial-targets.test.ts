import { describe, expect, it } from "vitest";
import { dialTargets } from "../driver.js";

describe("docker dialTargets", () => {
  it("reports a TCP daemon", () => {
    expect(dialTargets("tcp://docker.example.com:2376")).toEqual([
      { kind: "host", host: "docker.example.com", port: 2376 },
    ]);
  });

  it.each(["", "unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine"])(
    "reports %j as local",
    (h) => {
      expect(dialTargets(h)[0]!.kind).toBe("local");
    },
  );
});

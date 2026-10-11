import { describe, expect, it } from "vitest";
import { podImageDigests, podSpecImages } from "../resource-listers.js";
import type { K8sPod } from "../types.js";

describe("podSpecImages", () => {
  it("lists init, sidecar and app images once each", () => {
    expect(
      podSpecImages({
        initContainers: [{ name: "migrate", image: "ghcr.io/acme/api:1.2" }],
        containers: [
          { name: "api", image: "ghcr.io/acme/api:1.2" },
          { name: "proxy", image: "envoyproxy/envoy:v1.30" },
        ],
      }),
    ).toBe("ghcr.io/acme/api:1.2, envoyproxy/envoy:v1.30");
  });
});

describe("podImageDigests", () => {
  it("strips the runtime scheme and keeps only digests", () => {
    const status: K8sPod["status"] = {
      phase: "Running",
      containerStatuses: [
        {
          ready: true,
          restartCount: 0,
          state: {},
          imageID: "docker-pullable://nginx@sha256:abc",
        },
        { ready: true, restartCount: 0, state: {}, imageID: "" },
      ],
      initContainerStatuses: [{ imageID: "ghcr.io/acme/api@sha256:def" }],
    };
    expect(podImageDigests(status)).toBe("ghcr.io/acme/api@sha256:def, nginx@sha256:abc");
  });
});

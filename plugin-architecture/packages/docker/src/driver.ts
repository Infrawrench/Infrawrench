import Dockerode from "dockerode";
import type { DockerNodeDriver } from "@infrawrench/plugin-base";

function makeClient(dockerHost: string): Dockerode {
  if (!dockerHost || dockerHost.startsWith("unix://")) {
    const socketPath = dockerHost.replace("unix://", "") || "/var/run/docker.sock";
    return new Dockerode({ socketPath });
  }
  const url = new URL(dockerHost);
  return new Dockerode({ host: url.hostname, port: Number(url.port) || 2375 });
}

export const driver = {
  id: "docker",

  async command(dockerHost: string, op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const docker = makeClient(dockerHost);

    switch (op) {
      case "version":
        return docker.version();
      case "listContainers":
        return docker.listContainers({ all: true });
      case "inspectContainer":
        return docker.getContainer(params["id"] as string).inspect();
      case "startContainer":
        await docker.getContainer(params["id"] as string).start();
        return { ok: true };
      case "stopContainer":
        await docker.getContainer(params["id"] as string).stop();
        return { ok: true };
      case "restartContainer":
        await docker.getContainer(params["id"] as string).restart();
        return { ok: true };
      case "listImages":
        return docker.listImages({ all: false });
      default:
        throw new Error(`Docker driver: unknown op "${op}"`);
    }
  },
} satisfies DockerNodeDriver;

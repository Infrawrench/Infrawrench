import { attempt } from "@infrawrench/plugin-base/effect";
import { defineNodeDrivers } from "@infrawrench/plugin-base";
import type { PluginEffect } from "@infrawrench/plugin-base";
import Dockerode from "dockerode";
import { urlDialTarget, type DialTarget, type DockerNodeDriver } from "@infrawrench/plugin-base";

function makeClient(dockerHost: string): Dockerode {
  if (!dockerHost || dockerHost.startsWith("unix://")) {
    const socketPath = dockerHost.replace("unix://", "") || "/var/run/docker.sock";
    return new Dockerode({ socketPath });
  }
  const url = new URL(dockerHost);
  return new Dockerode({ host: url.hostname, port: Number(url.port) || 2375 });
}

/** The HTTP status dockerode puts on a failed call. */
function statusCode(e: unknown): number | undefined {
  const code = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * Where dockerode would connect: the local daemon socket for an empty host or
 * a `unix://` URL, otherwise the TCP endpoint `makeClient` builds.
 */
export function dialTargets(dockerHost: string): DialTarget[] {
  if (!dockerHost || dockerHost.startsWith("unix://")) {
    return [{ kind: "local", reason: "the Docker unix socket" }];
  }
  try {
    const url = new URL(dockerHost);
    if (url.protocol === "npipe:") return [{ kind: "local", reason: "a Docker named pipe" }];
    return [urlDialTarget(url, 2375)];
  } catch {
    return [{ kind: "local", reason: "a Docker host that is not a URL" }];
  }
}

export const driver = {
  id: "docker",
  dialTargets,

  command(
    dockerHost: string,
    op: string,
    params: Record<string, unknown> = {},
  ): PluginEffect<unknown> {
    return attempt(async () => {
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
        case "listVolumes": {
          const result = await docker.listVolumes();
          return result.Volumes ?? [];
        }
        case "listNetworks":
          return docker.listNetworks();
        case "createContainer": {
          const image = params["image"] as string;

          // Pull the image first so we get a clear error if it doesn't exist
          try {
            const stream = await docker.pull(image);
            await new Promise<void>((resolve, reject) => {
              docker.modem.followProgress(stream, (err: Error | null) =>
                err ? reject(err) : resolve(),
              );
            });
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to pull image "${image}": ${msg}`, { cause: e });
          }

          const container = await docker.createContainer({
            Image: image,
            name: params["name"] as string | undefined,
            ExposedPorts: params["exposedPorts"] as Record<string, object> | undefined,
            HostConfig: params["hostConfig"] as Dockerode.HostConfig | undefined,
          });
          if (params["start"]) await container.start();
          return container.inspect();
        }
        case "createVolume":
          return docker.createVolume({
            Name: params["name"] as string,
            Driver: params["driver"] as string | undefined,
          });
        case "createNetwork":
          return docker.createNetwork({
            Name: params["name"] as string,
            Driver: params["driver"] as string | undefined,
            Internal: Boolean(params["internal"]),
          });
        case "removeContainer": {
          await docker.getContainer(params["id"] as string).remove({ force: true });
          return { ok: true };
        }
        case "removeImage": {
          await docker.getImage(params["id"] as string).remove({ force: true });
          return { ok: true };
        }
        case "removeVolume": {
          await docker.getVolume(params["name"] as string).remove();
          return { ok: true };
        }
        case "removeNetwork": {
          await docker.getNetwork(params["id"] as string).remove();
          return { ok: true };
        }
        // CI jobs (`ci-executor.ts`). The answers for a name in use, or a
        // container that is gone, are values rather than errors: they are
        // what a retry or a teardown expects to meet.
        case "ciInfo": {
          const info = (await docker.info()) as Record<string, unknown>;
          return {
            OSType: info["OSType"],
            Architecture: info["Architecture"],
            ServerVersion: info["ServerVersion"],
          };
        }
        case "ciRun": {
          const name = params["name"] as string;
          const image = params["image"] as string;
          const body = params["body"] as Dockerode.ContainerCreateOptions;
          try {
            const stream = await docker.pull(image);
            await new Promise<void>((resolve, reject) => {
              docker.modem.followProgress(stream, (err: Error | null) =>
                err ? reject(err) : resolve(),
              );
            });
          } catch (e: unknown) {
            // A registry out of reach is fine when the image is already here.
            const present = await docker
              .getImage(image)
              .inspect()
              .then(() => true)
              .catch(() => false);
            if (!present) {
              const msg = e instanceof Error ? e.message : String(e);
              throw new Error(`Failed to pull image "${image}": ${msg}`, { cause: e });
            }
          }
          let container: Dockerode.Container;
          try {
            container = await docker.createContainer({ ...body, name });
          } catch (e: unknown) {
            if (statusCode(e) === 409) return { conflict: true };
            throw e;
          }
          await container.start();
          return { id: container.id };
        }
        case "ciStartContainer": {
          try {
            await docker.getContainer(params["id"] as string).start();
          } catch (e: unknown) {
            // 304: already started.
            if (statusCode(e) !== 304) throw e;
          }
          return { ok: true };
        }
        case "ciInspect": {
          try {
            return await docker.getContainer(params["id"] as string).inspect();
          } catch (e: unknown) {
            if (statusCode(e) === 404) return null;
            throw e;
          }
        }
        case "ciRemove": {
          try {
            await docker.getContainer(params["id"] as string).remove({ force: true, v: true });
          } catch (e: unknown) {
            // 404: gone. 409: AutoRemove is already removing it.
            const status = statusCode(e);
            if (status !== 404 && status !== 409) throw e;
          }
          return { ok: true };
        }
        case "ciList":
          return docker.listContainers({
            all: true,
            filters: { label: [params["label"] as string] },
          });
        default:
          throw new Error(`Docker driver: unknown op "${op}"`);
      }
    });
  },
} satisfies DockerNodeDriver;

/**
 * What this plugin contributes to each kind of host. See `PluginNodeDrivers`.
 */
export const nodeDrivers = defineNodeDrivers({
  desktop: { docker: driver },
  server: { docker: driver },
});

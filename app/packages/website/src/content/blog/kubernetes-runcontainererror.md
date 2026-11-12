---
title: "Kubernetes RunContainerError and StartError: fix commands that will not start"
description: "Fix a Kubernetes container stuck in RunContainerError or terminated with StartError and exit code 128 by reading the runtime's message, then fixing a missing executable, a permission or architecture problem, or a bad mount."
date: "2026-11-12"
kind: guide
---

A container in RunContainerError, or one whose last state shows StartError with exit code 128, was created by the container runtime but could not be started. The image was pulled and the container exists, then the runtime tried to launch its process and failed before your application ran a single line. That is why the container logs are empty. The cause is in the message the runtime returned, and it usually falls into one of four groups: the command does not exist in the image, the file exists but cannot be executed, the image was built for a different CPU architecture, or a volume mount failed. This guide shows how to read the message, decide which group you are in, and fix it.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods and events. The debugging steps additionally need permission to create pods in the namespace, and the image checks need Docker or another tool that can pull and inspect images. Everything here follows the official Kubernetes documentation on [debugging pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/), [debugging running pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/) and [commands and arguments](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME, NODE_NAME, IMAGE and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## RunContainerError, StartError or CreateContainerError?

These three sit next to each other in the container's life:

- **CreateContainerError** means the runtime refused to create the container at all, for example because there is no command to run or a container with the same name already exists. The [CreateContainerError guide](/blog/kubernetes-createcontainererror) covers that case.
- **RunContainerError** is a waiting reason: the container was created, and starting it failed. The kubelet retries, so you will often see the pod move between RunContainerError and CrashLoopBackOff.
- **StartError** is the same failure seen afterwards, as a terminated state. Depending on the runtime and its version, you may never see RunContainerError and only find a last state of Terminated with reason StartError and exit code 128.

If the container did start and then exited, with your application's own output in the logs and an exit code other than 128, the process ran and something inside it failed. The [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) is the better route for that.

## Step 1: Confirm the state and read the message

Check you are pointed at the right cluster, then print each container's waiting reason and its last terminated state:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\twaiting="}{.state.waiting.reason}{"\tlast="}{.lastState.terminated.reason}{"\texit="}{.lastState.terminated.exitCode}{"\n"}{.lastState.terminated.message}{"\n"}{end}'
```

Init containers can fail the same way and hold up the whole pod. Swap `containerStatuses` for `initContainerStatuses` to check them. Write down the NODE column from the `-o wide` output; you will need it for the architecture check.

Then read the events:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME --sort-by=.lastTimestamp
```

Look for a Warning with the reason Failed. The message usually contains a long runtime prefix (often starting with `failed to create containerd task` or `OCI runtime create failed`) and, near the end, the part that matters: something like `exec: "NAME": executable file not found in $PATH`, `permission denied`, `no such file or directory`, `exec format error`, or an error about a mount. The exact wording depends on the runtime and its version, so match on the meaning rather than the precise words.

## Step 2: Executable file not found

A message saying the executable was not found in `$PATH`, or that the file does not exist, means the runtime looked for the command and it is not where the container says it is. Common causes:

- A typo in `command` or `args`, or a command that only exists in a different image (a debug image, or the build stage of a multi-stage Dockerfile).
- A shell command written as one string, such as `command: ["npm run start"]`. The runtime looks for an executable literally called `npm run start`. Split it into separate items, or run it through a shell: `command: ["sh", "-c", "npm run start"]`, which needs `sh` to exist in the image.
- A minimal image (distroless, `scratch`-based) that has no shell, so any command starting with `sh` or `bash` fails.
- A relative path that only worked because the image's working directory was different.

Check what the image and the pod spec ask for:

```
docker image inspect IMAGE --format 'Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}} WorkingDir={{.Config.WorkingDir}}'
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\tcommand="}{.command}{"\targs="}{.args}{"\n"}{end}'
```

Remember how they combine: `command` in the pod spec replaces the image's ENTRYPOINT, and `args` replaces its CMD. Then look inside the image for the file. If the image has a shell, list the path directly:

```
docker run --rm --entrypoint sh IMAGE -c 'ls -l /path/to/command; echo $PATH'
```

If it has no shell, list the image's files from outside instead:

```
CID=$(docker create IMAGE)
docker export "$CID" | tar -t | grep 'path/to/command'
docker rm "$CID"
```

If the image does have a shell, you can also try the fix in the cluster before changing the workload. The official docs show how to copy a pod while changing its command, which starts a shell in place of the broken command:

```
kubectl --context CONTEXT_NAME debug POD_NAME -n NAMESPACE -it --copy-to=POD_NAME-debug --container=CONTAINER_NAME -- sh
```

Run the intended command from that shell to see the real error, then fix the command in the workload's pod template, or fix the image so the file is where the command expects it. Delete the debug copy when you are done:

```
kubectl --context CONTEXT_NAME delete pod POD_NAME-debug -n NAMESPACE
```

## Step 3: Permission denied, or a script that will not run

A `permission denied` message means the file exists but the runtime is not allowed to execute it. Usually:

- The file is not marked executable. A script copied into the image without its execute bit fails this way. Add `RUN chmod +x /path/to/script` to the Dockerfile, or call it through its interpreter (`command: ["sh", "/path/to/script"]`).
- The container runs as a user that cannot read or execute the file. Check `securityContext.runAsUser` in the pod spec against the file's owner and mode in the image.
- The file lives on a volume mounted with permissions that block execution, or on a ConfigMap volume whose `defaultMode` does not include the execute bit. Set `defaultMode: 0755` on the volume if the script needs to run from there.

A script can also fail with `no such file or directory` even though `ls` shows it. That points at the first line rather than the file: the interpreter in the shebang (`#!/bin/bash`) is missing from the image, or the script was saved with Windows line endings so the runtime looks for an interpreter named `bash` followed by a carriage return. Check both:

```
docker run --rm --entrypoint sh IMAGE -c 'head -1 /path/to/script | od -c | head -2; ls -l /bin/bash /bin/sh'
```

A `\r` before the `\n` in the output means Windows line endings. Convert the file to Unix line endings, or point the shebang at an interpreter the image has.

## Step 4: Exec format error

`exec format error` means the binary was built for a different CPU architecture than the node it landed on, most often an amd64 image on an arm64 node or the other way round. It tends to appear when a cluster gains arm64 nodes, or when an image built on an Apple silicon laptop is pushed without a multi-architecture manifest.

Compare the node with the image:

```
kubectl --context CONTEXT_NAME get node NODE_NAME -L kubernetes.io/arch
docker image inspect IMAGE --format '{{.Os}}/{{.Architecture}}'
docker manifest inspect IMAGE
```

If the image only lists one architecture and it does not match the node, there are two fixes. Build and push a multi-architecture image so each node pulls the right variant, or keep the workload on matching nodes with a node selector in the pod template:

```
nodeSelector:
  kubernetes.io/arch: amd64
```

The same error can come from a script with no shebang at all. If the architectures match, check the first line as in Step 3.

## Step 5: The mount failed

Messages about mounting, such as `not a directory`, `are you trying to mount a directory onto a file (or vice-versa)?` or errors that name a `subPath`, mean the runtime could not set up one of the container's volumes when it started. Common causes:

- A `subPath` mount of a single file, where the target path in the image is a directory, or the other way round. Make the type on both sides match.
- A `subPath` that names a key or folder that does not exist in the volume.
- A `subPathExpr` that refers to an environment variable which is empty or unset.

Print the container's mounts next to its volumes and compare them with what is inside the image at each `mountPath`:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*].volumeMounts[*]}{.name}{"\t"}{.mountPath}{"\tsubPath="}{.subPath}{"\n"}{end}'
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.volumes}'
```

Fix the mount path or the `subPath` in the workload's pod template. If the volume itself never attaches, the pod usually stays in ContainerCreating instead, and the [ContainerCreating guide](/blog/kubernetes-pod-stuck-containercreating) covers that.

## Step 6: Roll out the fix

A pod's containers cannot be changed in place for these fields, so edit the Deployment, StatefulSet, DaemonSet or Job that owns the pod, or push a fixed image and update the tag. If the error started with a new revision, rolling back keeps the service up while you fix it:

```
kubectl --context CONTEXT_NAME rollout history deployment/DEPLOYMENT_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME rollout undo deployment/DEPLOYMENT_NAME -n NAMESPACE
```

## Step 7: Verify

Watch the pod leave the error state:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -w
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
```

STATUS should move to Running and the RESTARTS count should stop climbing. If the container now starts but exits with your application's own error, the start problem is fixed and the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) takes over. If the rollout itself stays stuck, the [Deployment rollout stuck guide](/blog/kubernetes-deployment-rollout-stuck) covers what to check next.

## Conclusion

RunContainerError and StartError with exit code 128 mean the runtime created the container and could not launch its process. Read the runtime's message, then decide which group you are in: a command that is not in the image, a file that cannot be executed, a binary for the wrong architecture, or a mount that could not be set up. Fix the command or image, match the architecture, or correct the mount, then roll the change out through the workload. Once the cause is gone, the kubelet starts the container on its next attempt.

If chasing problems like this means jumping between clusters, cloud consoles and node terminals, Infrawrench puts them in one platform: the Infrastructure app gives you Kubernetes exec and logs, SSH and SQL across your connected cloud accounts. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debug running pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Define a command and arguments for a container](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/)
- [Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Volumes: using subPath](https://kubernetes.io/docs/concepts/storage/volumes/#using-subpath)
- [Well-known labels: kubernetes.io/arch](https://kubernetes.io/docs/reference/labels-annotations-taints/#kubernetes-io-arch)

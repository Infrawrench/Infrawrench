---
title: "Kubernetes CreateContainerError: fix missing commands, name conflicts and runtime failures"
description: "Fix a Kubernetes pod stuck in CreateContainerError by reading the event message, then fixing a missing command, a container name conflict or a problem with the node's container runtime."
date: "2026-11-11"
kind: guide
---

A pod in CreateContainerError has been scheduled, its image has been pulled and its configuration has been built, but the container runtime on the node refused to create the container. Nothing has run yet, so there are no logs to read. The reason is almost always in the event message, and it usually falls into one of three groups: the container has no command to run, a container with the same name already exists in the runtime, or the runtime on that node is unhealthy. This guide shows how to read the message, decide which group you are in, and fix it.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods and events. Node-level checks additionally need permission to read nodes and, for the runtime checks, shell access to the node. Everything here follows the official Kubernetes documentation on [debugging pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/), [commands and arguments](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/) and [debugging nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, NODE_NAME, IMAGE and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## CreateContainerError or CreateContainerConfigError?

The two names are close, and they point at different layers:

- **CreateContainerConfigError** comes from the kubelet before it asks the runtime for anything. It means the kubelet could not build the container's configuration, usually because a ConfigMap, Secret or key is missing. The [CreateContainerConfigError guide](/blog/kubernetes-createcontainerconfigerror) covers that case.
- **CreateContainerError** comes back from the container runtime (containerd or CRI-O) when the kubelet asks it to create the container. The configuration was built, and the runtime rejected it or failed while handling it.

If the container is created but fails when it starts, for example because the command does not exist inside the image, you will usually see RunContainerError or a container that exits straight away instead. That is a start problem, and the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) is the better route.

## Step 1: Confirm the waiting reason and message

Check you are pointed at the right cluster, then print each container's waiting reason and message:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.initContainerStatuses[*]}init:{.name}{"\t"}{.state.waiting.reason}{"\t"}{.state.waiting.message}{"\n"}{end}{range .status.containerStatuses[*]}{.name}{"\t"}{.state.waiting.reason}{"\t"}{.state.waiting.message}{"\n"}{end}'
```

The `-o wide` output shows the NODE column. Write it down: if the problem turns out to be the node, you will need it. Init containers count too: one that cannot be created holds up the whole pod.

## Step 2: Read the events

Describe the pod and read the Events section at the bottom:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Or list only this pod's events, oldest first:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME --sort-by=.lastTimestamp
```

Look for a Warning with the reason Failed and a message that starts with `Error:`. The text after it is what the runtime returned. Match it against the groups below. The exact wording depends on the runtime and its version, so match on the meaning rather than the precise words.

## Step 3: No command specified

A message along the lines of `no command specified` means the runtime has nothing to run. The image has no ENTRYPOINT or CMD, and the pod spec sets no `command` or `args` to fill the gap.

The official docs describe how the two layers combine: `command` in the pod spec overrides the image's ENTRYPOINT, and `args` overrides its CMD. If neither the image nor the spec says what to run, there is no process to create a container for. This is common with minimal or base images (`scratch`-based images, some distroless images, an image built from a Dockerfile that forgot its final CMD) and with a template that sets `args` but not `command` for an image with no ENTRYPOINT.

Check what the image declares. With Docker or another local tool:

```
docker image inspect IMAGE --format 'Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}}'
```

Then check what the pod spec sets:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\tcommand="}{.command}{"\targs="}{.args}{"\n"}{end}'
```

Fix it in one of two places:

- **Set `command` (and `args` if needed) in the workload's pod template.** This is the quickest fix and keeps the image unchanged.
- **Add an ENTRYPOINT or CMD to the image** and push a new tag. This fixes it for everyone who runs the image.

A pod's spec cannot be edited in place for these fields, so change the Deployment, StatefulSet, DaemonSet or Job that owns it. The controller rolls out new pods with the fix.

## Step 4: Container name already in use

A message saying the container name is already in use, or that it is reserved for another container, means the runtime on that node still holds a container with the name the kubelet wants to use. The kubelet names each container after its pod and attempt, so this usually follows something that interrupted it: a kubelet or runtime restart in the middle of creating a container, a node under heavy load where a create call timed out but carried on in the background, or a leftover container from an earlier attempt that was never cleaned up.

First, wait a minute and look again. The kubelet retries, and the runtime often finishes or cleans up the earlier attempt on its own. If the error stays, look at the containers the runtime holds for that pod. On the node:

```
sudo crictl pods --name POD_NAME
sudo crictl ps -a --pod POD_SANDBOX_ID
```

The first command gives the pod sandbox ID to use in the second. A container in the Created or Exited state with the conflicting name is the leftover.

The safest fix is to let Kubernetes start over: delete the pod and let its controller create a new one, which gets a new sandbox and new container names:

```
kubectl --context CONTEXT_NAME delete pod POD_NAME -n NAMESPACE
```

If new pods on the same node keep hitting the same error, the runtime itself is struggling. Move on to Step 5.

## Step 5: The runtime on the node is unhealthy

Other messages point at the node rather than the pod: timeouts talking to the runtime, errors writing to its storage, errors creating or preparing the container's filesystem, or `no space left on device`. A useful test is whether other pods on the same node have the same problem:

```
kubectl --context CONTEXT_NAME get pods -A -o wide --field-selector spec.nodeName=NODE_NAME
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

In the node description, check the Conditions for DiskPressure, MemoryPressure, PIDPressure and Ready, and read the node's events. If the disk holding the runtime's images and containers is full, the runtime cannot create new containers; the [node DiskPressure guide](/blog/kubernetes-node-diskpressure) shows how to find what is using the space. If the node is NotReady or flapping, follow the [node NotReady guide](/blog/kubernetes-node-not-ready).

With shell access to the node, check that the runtime answers and read its logs. The service name depends on the runtime:

```
sudo crictl info
sudo journalctl -u containerd --since "30 min ago"
sudo journalctl -u kubelet --since "30 min ago"
```

For CRI-O, use `crio` as the unit name instead of `containerd`. Errors there around the same time as the pod's events usually name the real cause.

While you fix the node, keep new pods off it, and move the affected pods somewhere healthy:

```
kubectl --context CONTEXT_NAME cordon NODE_NAME
kubectl --context CONTEXT_NAME delete pod POD_NAME -n NAMESPACE
```

The replacement pod is scheduled on another node. Uncordon the node once the runtime is healthy again:

```
kubectl --context CONTEXT_NAME uncordon NODE_NAME
```

## Step 6: Anything else

If the message fits none of the groups above, the runtime is still telling you what it rejected. Copy the text after `Error:` and look for the field it names in the pod spec. Compare the failing pod's spec with a pod from the same workload that runs, or with the previous revision of the Deployment:

```
kubectl --context CONTEXT_NAME rollout history deployment/DEPLOYMENT_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME rollout history deployment/DEPLOYMENT_NAME -n NAMESPACE --revision=REVISION
```

If the error started with a new revision, the difference between the two revisions is where to look. Rolling back buys time while you work it out:

```
kubectl --context CONTEXT_NAME rollout undo deployment/DEPLOYMENT_NAME -n NAMESPACE
```

## Step 7: Verify

Watch the pod leave the waiting state:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -w
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
```

STATUS should move to Running and READY should show every container ready. If the container is now created but exits straight away, the command runs and something after it fails: follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff). If the rollout itself stays stuck, the [Deployment rollout stuck guide](/blog/kubernetes-deployment-rollout-stuck) covers what to check next.

Write down which group it was. A missing command belongs in the image or the template so it cannot happen again, and repeated name conflicts or runtime errors on the same node are worth a closer look at that node before it fails in a bigger way.

## Conclusion

CreateContainerError means the container runtime refused to create the container. Read the event message, then decide which group you are in: no command to run, a leftover container with the same name, or a runtime that is unhealthy on that node. Set a command in the template or the image, let Kubernetes recreate the pod, or fix and drain the node. The kubelet keeps retrying, so once the cause is gone the pod starts on its own or on its replacement.

If you switch between clusters, cloud consoles and node terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Define a command and arguments for a container](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Container runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Safely drain a node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)

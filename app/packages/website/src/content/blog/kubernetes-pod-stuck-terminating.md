---
title: "Kubernetes pod stuck in Terminating: find what is holding it and fix it safely"
description: "Fix a Kubernetes pod stuck in Terminating by checking its deletion timestamp, grace period, preStop hooks, SIGTERM handling, finalizers and node health before you reach for force deletion."
date: "2026-10-31"
kind: guide
---

A pod that shows Terminating has been asked to go away and has not finished going. Most of the time it clears within the grace period, 30 seconds by default. When it sits there for minutes or hours, something is holding it: a slow preStop hook, an application that ignores SIGTERM, a finalizer nobody is removing, or a node that can no longer report back. This guide shows how to work out which one it is, fix the cause, and understand exactly what you risk when you force delete instead.

Prerequisites: kubectl installed, access to the cluster and permission to read and delete pods, read nodes and events. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME and NODE_NAME. Replace them before running a command. For pods that fail before they ever start, the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events) is the better starting point.

## What Terminating actually means

Terminating is not a pod phase. It is what kubectl prints when a pod has a deletion timestamp set. When you delete a pod, the API server records the time it was asked to delete it and the grace period it has. The kubelet on the pod's node sees that and starts a local shutdown:

1. If a container has a `preStop` hook and the grace period is not 0, the kubelet runs the hook.
2. The container runtime sends a TERM signal to process 1 in each container. Many runtimes send the image's `STOPSIGNAL` instead if it defines one.
3. When the grace period runs out, any process still running gets KILL.
4. The kubelet moves the pod to a terminal phase and removes the pod object from the API server.

At the same time, the control plane marks the pod's endpoints as terminating in EndpointSlices, so Services stop sending it regular traffic, and its ReplicaSet or other controller stops counting it as a live replica.

So a pod that stays in Terminating is stuck somewhere in that list, or the object cannot be removed because something else still has a claim on it. Each has a different fix.

## Step 1: Read the deletion timestamp and grace period

Check you are pointed at the right cluster, then read when the deletion was requested, the grace period it was given and the node it runs on:

```
kubectl config current-context
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -o jsonpath='{.metadata.deletionTimestamp}{"\t"}{.metadata.deletionGracePeriodSeconds}{"\t"}{.spec.nodeName}{"\n"}{.metadata.finalizers}{"\n"}'
```

That prints the deletion timestamp, the grace period in seconds, the node name and any finalizers on the pod. Compare the timestamp with the current time. If the pod is still within its grace period, it is shutting down as designed: wait. If the grace period has long passed, keep going.

Then read the events and container states:

```
kubectl --context CONTEXT_NAME -n NAMESPACE describe pod POD_NAME
```

Look for `FailedPreStopHook` or `Killing` events and for containers still shown as Running.

## Step 2: Check the node

The kubelet does the shutdown work. If the node it runs on is down or cut off from the API server, nothing on that node can finish the deletion. Check the node from Step 1:

```
kubectl --context CONTEXT_NAME get node NODE_NAME
```

If the node shows NotReady, the problem is the node, not the pod. Pods on a node that cannot be reached enter Terminating or Unknown after a timeout, and stay there. According to the Kubernetes docs, such a pod is only removed from the API server when one of three things happens:

- The Node object is deleted, by you or by the node controller.
- The kubelet on the node starts responding again, kills the pod and removes it.
- You force delete the pod.

The documentation recommends the first two. If the node is confirmed dead, for example powered off or permanently disconnected, delete the Node object. If it is a network partition, fix the network or wait: when the partition heals, the kubelet completes the deletion itself. The [node NotReady guide](/blog/kubernetes-node-not-ready) walks through finding out which case you are in, and covers the `node.kubernetes.io/out-of-service` taint for nodes that shut down without warning.

If the node is Ready, the kubelet is alive and the hold-up is inside the pod or on the object. Go on to Step 3.

## Step 3: Check preStop hooks and the grace period

A preStop hook must finish before the TERM signal is sent. The grace period countdown starts before the hook runs, and it covers the hook and the container's own shutdown together. If the hook hangs, the pod stays in Terminating until the grace period expires and the container is killed. If the hook is still running when the grace period expires, the kubelet grants a single extra 2 seconds.

Read the hooks and the grace period from the pod spec:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -o jsonpath='{.spec.terminationGracePeriodSeconds}{"\n"}{range .spec.containers[*]}{.name}{"\t"}{.lifecycle.preStop}{"\n"}{end}'
```

Two patterns cause trouble:

- **A long grace period.** If `terminationGracePeriodSeconds` is set to something like 3600, a pod that ignores TERM legitimately sits in Terminating for up to an hour before the kubelet kills it. That is working as configured.
- **A hook that takes longer than the grace period.** The docs give the example of a 60 second grace period, a hook that takes 55 seconds and a container that needs 10 seconds to stop: the container is killed before it stops cleanly. If the hook really needs that long, raise `terminationGracePeriodSeconds` to cover both.

Keep hooks short. A hook that waits on a network call to a service that is down is a common cause of slow shutdowns. Hooks are also delivered at least once, so a hook may run more than once and must cope with that.

## Step 4: Check that the application handles SIGTERM

If there is no preStop hook, the delay is usually the application. The runtime sends TERM to process 1 in the container. If process 1 is a shell wrapper that does not pass signals on, or the application does not handle TERM at all, nothing happens until the grace period ends and KILL arrives. Every deletion then takes the full grace period.

Check what process 1 is in the container:

```
kubectl --context CONTEXT_NAME -n NAMESPACE exec POD_NAME -c CONTAINER_NAME -- cat /proc/1/cmdline
```

If process 1 is `sh -c` or a script, make the script `exec` the application so the application becomes process 1, or handle the signal in the script. If the application uses a different signal to shut down cleanly, set `STOPSIGNAL` in the image. Newer clusters with the `ContainerStopSignals` feature gate enabled also accept `lifecycle.stopSignal` in the container spec, which needs `spec.os.name` set on the pod.

For pods with sidecar containers, the kubelet waits until the last main container has stopped before it sends TERM to the sidecars, in reverse order. A main container that stops slowly therefore delays the sidecars too.

## Step 5: Check finalizers

If the containers are gone but the pod object is still there, look at its finalizers. Step 1 printed them. A finalizer is a key on the object that tells the API server not to remove it until a controller has done some cleanup and removed the key. While any finalizer remains, an object with a deletion timestamp stays in place, and it is deleted automatically once the list is empty.

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -o jsonpath='{.metadata.finalizers}{"\n"}'
```

If the list is not empty, find the controller that owns each finalizer from its name, for example a domain belonging to an operator or tool installed in the cluster, and check that the controller is running and look at its logs. A finalizer stays forever when the controller that should remove it has been uninstalled, crashed or lost permissions.

The Kubernetes docs warn against removing finalizers by hand to get past a stuck deletion. Finalizers are there for a reason, and removing one can cause problems in your cluster. Only remove one when you understand what it protects and have done that cleanup another way.

Once a deletion is requested you can remove finalizers but not add them, and you cannot undo the deletion. The only way back is to create a new, similar object.

## Step 6: Force delete only when you understand the risk

A force deletion removes the pod from the API server straight away, without waiting for the kubelet to confirm that the containers have stopped:

```
kubectl --context CONTEXT_NAME -n NAMESPACE delete pod POD_NAME --grace-period=0 --force
```

The docs are explicit about the risk: immediate deletion does not wait for confirmation that the running resource has been terminated, and it may keep running on the node indefinitely. If the node is reachable, the kubelet starts cleanup right away, with a short grace period before the kill. If the node is unreachable, the processes can carry on with no pod object tracking them.

For a Deployment's pods this is usually tolerable, because a replacement gets a new name. For StatefulSet pods it is dangerous. A StatefulSet guarantees at most one running pod for each identity, and the docs say that in normal operation there is never a need to force delete a StatefulSet pod. Force deleting frees the name at once, so the controller can create a replacement with the same identity while the original may still be running. For clustered and quorum-based systems that can mean two members with the same identity, split brain and data loss.

Force delete a StatefulSet pod only when you are certain the original will never again talk to the other members, for example because the node is confirmed powered off. Prefer deleting the Node object or fixing the partition, as in Step 2. Avoid setting `terminationGracePeriodSeconds` to 0 on StatefulSet pods; the docs call it unsafe and strongly discouraged.

If a pod is still stuck in Unknown after a force deletion, the docs show clearing its finalizers as the last step. The warning in Step 5 applies:

```
kubectl --context CONTEXT_NAME -n NAMESPACE patch pod POD_NAME -p '{"metadata":{"finalizers":null}}'
```

## Step 7: Verify

Check that the pod is gone and that its replacement is running:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pods -o wide
```

The old pod should no longer be listed, and the replacement should reach Running with every container ready. If the replacement sits in [Pending](/blog/kubernetes-pod-pending), follow that guide. If you used force deletion on an unreachable node, check the node itself once it is back and make sure the old containers are no longer running.

## Conclusion

A pod stuck in Terminating is waiting on something. Read the deletion timestamp and grace period, check that the node is healthy, then look at preStop hooks, SIGTERM handling and finalizers in that order. Fix the cause when you can. Treat force deletion as a statement that the old pod will never come back, especially for StatefulSets.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Pod lifecycle: termination of pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- [Pod lifecycle: forced pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination-forced)
- [Container lifecycle hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- [Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- [Force delete StatefulSet pods](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/)
- [Nodes](https://kubernetes.io/docs/concepts/architecture/nodes/)

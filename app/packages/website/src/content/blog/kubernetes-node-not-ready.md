---
title: "Kubernetes node NotReady: read node conditions and bring it back"
description: "Find out why a Kubernetes node is NotReady by reading its Ready condition, heartbeat and taints, then check the kubelet and container runtime and handle pod eviction."
date: "2026-10-31"
kind: guide
---

A node in NotReady has stopped telling the control plane that it is healthy. New pods stop landing on it, and after a few minutes the pods already on it are evicted and recreated somewhere else. The symptom shows up in `kubectl get nodes`, but the cause lives on the node itself: usually the kubelet, the container runtime, the network or the machine underneath. This guide shows how to read what the control plane knows about the node, tell an unhealthy node from an unreachable one, check the kubelet and runtime, and understand the eviction clock that starts when a node goes NotReady.

Prerequisites: kubectl installed, access to the cluster, permission to read nodes, leases and events, and ideally SSH or console access to the node. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/debug/debug-cluster/). Placeholders used throughout: CONTEXT_NAME and NODE_NAME. Replace them before running a command. If you got here from pods that will not start, the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events) covers the pod side.

## What NotReady actually means

Every node reports a set of conditions in its status. The one that matters here is Ready, and it has three possible values:

- **True**: the node is healthy and ready to accept pods.
- **False**: the kubelet is reporting in, but says the node is not healthy and cannot accept pods.
- **Unknown**: the node controller has not heard from the node within the node monitor grace period, which defaults to 50 seconds.

`kubectl get nodes` prints NotReady for both False and Unknown, but they point in different directions. False means the kubelet is alive and telling you something is wrong. Unknown means nothing is arriving at all: the kubelet is down, the machine is off, or the network between the node and the API server is broken. Telling the two apart is the first step.

## Step 1: Read the Ready condition

Check you are pointed at the right cluster, then list nodes:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get nodes -o wide
```

For the node in trouble, print the Ready condition with its reason, message and timestamps:

```
kubectl --context CONTEXT_NAME get node NODE_NAME -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{"\t"}{.reason}{"\t"}{.lastHeartbeatTime}{"\t"}{.lastTransitionTime}{"\n"}{.message}{"\n"}{end}'
```

A healthy node shows True with the reason KubeletReady and a message like "kubelet is posting ready status". A status of False usually carries a reason and message from the kubelet that names the problem, for example the container runtime or the network plugin not being ready. A status of Unknown usually carries a message saying the kubelet stopped posting node status, and the heartbeat time shows when the control plane last heard from it.

The full picture is in describe, which shows every condition, the taints, the pods on the node and recent events:

```
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

Read the other conditions too. MemoryPressure, DiskPressure or PIDPressure set to True mean the node is short of memory, disk or process IDs. NetworkUnavailable set to True means the node's network is not correctly configured. Any of these can explain a node that is struggling, and the fix for pressure is on the node, not in Kubernetes.

## Step 2: Check the heartbeat

Nodes send two kinds of heartbeat. The kubelet updates the node's status when something changes, or every 5 minutes by default if nothing does. It also renews a Lease object in the `kube-node-lease` namespace every 10 seconds by default, and the control plane uses that lease's renew time to decide whether the node is available.

Read the lease for the node:

```
kubectl --context CONTEXT_NAME get lease NODE_NAME -n kube-node-lease -o jsonpath='{.spec.renewTime}{"\n"}'
```

If the renew time is a few seconds old, the kubelet is running and talking to the API server, and the problem is something the kubelet is reporting: go to Step 4. If the renew time stopped advancing, the kubelet is not reaching the API server. Either the kubelet is down, the machine is down, or the network path is broken: go to Step 3 before you blame the kubelet.

## Step 3: Rule out the machine and the network

When the control plane hears nothing, check the machine from outside Kubernetes first. In your cloud provider's console or API, confirm the VM still exists and is running, not stopped, terminated or stuck rebooting. Running in a cloud, the node controller also asks the provider whether the VM still exists, and deletes the Node object if it does not, so a node that vanishes from `kubectl get nodes` was often removed at the provider.

If the VM is running, try to reach it over SSH. If you can, check that it can reach the API server address in its kubeconfig, because a firewall, security group or routing change can cut the node off while it keeps running. If you cannot reach it at all, use the provider's serial console or recovery tools, or replace the machine.

## Step 4: Check the kubelet and the container runtime

The kubelet is the agent that reports node status, and it depends on the container runtime to run pods. On the node, check both. On most systemd-based Linux nodes:

```
systemctl status kubelet
journalctl -u kubelet --since "30 min ago"
```

On systems that write log files instead, the kubelet log is usually `/var/log/kubelet.log`. Look for the kubelet failing to start, failing to authenticate to the API server, failing to reach the container runtime, or reporting that the network plugin is not ready. Restarting the kubelet hides those messages, so read them before you restart anything.

Then check the runtime through its CRI socket with crictl:

```
crictl info
crictl ps -a
```

If crictl cannot connect, the runtime itself is down or misconfigured, and the kubelet cannot run pods until it is fixed. Check the runtime's own service and logs, for example `systemctl status containerd` on nodes that use containerd.

If SSH is not available but the kubelet is still running, `kubectl debug node` starts a pod on the node with the node's root filesystem mounted at `/host`:

```
kubectl --context CONTEXT_NAME debug node/NODE_NAME -it --image=ubuntu
```

From inside it you can read `/host/var/log/kubelet.log`, `/host/var/log/syslog` or `/host/var/log/kern.log`. It needs a working kubelet to start the pod, so it does not help on a node that has stopped heartbeating.

Common causes this step uncovers: a full disk, which also shows as DiskPressure; memory exhaustion on the node, covered in the [OOMKilled guide](/blog/kubernetes-oomkilled); a container runtime that stopped; and a node network that is not correctly configured.

## Step 5: Understand the taints and the eviction clock

When the Ready condition stays False or Unknown past the grace period, the control plane taints the node:

- `node.kubernetes.io/not-ready` when Ready is False.
- `node.kubernetes.io/unreachable` when Ready is Unknown.

Both carry the NoExecute effect, which does two things. The scheduler stops placing new pods on the node, which is why pods can sit in [Pending](/blog/kubernetes-pod-pending) when several nodes go NotReady at once. And pods already on the node are evicted unless they tolerate the taint.

Kubernetes adds a toleration for both taints with `tolerationSeconds: 300` to pods that do not set one themselves. That is the eviction clock: by default, pods stay bound to a failing node for 5 minutes after the problem is detected, then they are evicted and their controllers create replacements elsewhere. DaemonSet pods get these tolerations with no time limit, so they are never evicted for these taints.

List taints across nodes to see which ones are affected:

```
kubectl --context CONTEXT_NAME get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

Two details catch people out. First, on an unreachable node the API server cannot tell the kubelet to stop the pods, so pods scheduled for deletion may keep running on the partitioned node until it reconnects. Second, the control plane slows or stops evictions when many nodes fail together. By default, once at least 55% of the nodes in a zone are unhealthy at once, evictions slow down, and in a cluster of 50 nodes or fewer they stop entirely. If every node in the cluster is unhealthy, the control plane assumes it has a connectivity problem and evicts nothing.

If a workload with a lot of local state should wait longer before being moved, set its own toleration:

```yaml
tolerations:
  - key: "node.kubernetes.io/unreachable"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 6000
```

## Step 6: Recover or retire the node

If you fixed the kubelet, runtime or network, the kubelet starts reporting again, the Ready condition returns to True and the control plane removes the not-ready or unreachable taint. Watch it come back:

```
kubectl --context CONTEXT_NAME get node NODE_NAME -w
```

If the machine is gone for good, cordon and drain it if it is still reachable, then delete the Node object so the cluster stops tracking it:

```
kubectl --context CONTEXT_NAME drain NODE_NAME --ignore-daemonsets
kubectl --context CONTEXT_NAME delete node NODE_NAME
```

For a node that shut down without warning, pods from a StatefulSet can stay stuck terminating, because a replacement with the same name cannot be created while the old one is still recorded on the dead node. Once you have confirmed the node is really shut down or powered off, not in the middle of restarting, you can add the `node.kubernetes.io/out-of-service` taint with the NoExecute effect. Pods without a matching toleration are then force deleted and their volumes detached, so they can start on another node:

```
kubectl --context CONTEXT_NAME taint nodes NODE_NAME node.kubernetes.io/out-of-service:NoExecute
```

Remove that taint yourself once the pods have moved and the node is recovered or deleted:

```
kubectl --context CONTEXT_NAME taint nodes NODE_NAME node.kubernetes.io/out-of-service:NoExecute-
```

## Step 7: Verify

Check that every node reports Ready and the replacement pods are running:

```
kubectl --context CONTEXT_NAME get nodes
kubectl --context CONTEXT_NAME get pods -A -o wide --field-selector spec.nodeName=NODE_NAME
```

The node should show Ready, and the pods on it should reach Running with every container ready. If pods elsewhere are stuck in Pending because capacity dropped, follow the [Pending guide](/blog/kubernetes-pod-pending). Write down what took the node out and how you found it. The same failure on the next node will take minutes instead of an hour.

## Conclusion

NotReady is a condition, not a diagnosis. Read the Ready condition and its reason, check whether the lease is still renewing, rule out the machine and the network, then read the kubelet and runtime logs on the node. Know the 5 minute eviction clock so you can decide whether to fix the node quickly or let the pods move.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Troubleshooting clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Nodes](https://kubernetes.io/docs/concepts/architecture/nodes/)
- [Node status](https://kubernetes.io/docs/reference/node/node-status/)
- [Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- [Taints and tolerations: taint based evictions](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-based-evictions)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Debugging Kubernetes nodes with kubectl](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/)
- [Node shutdowns: non-graceful node shutdown](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)

---
title: "Kubernetes troubleshooting: pods, logs and events"
description: "Diagnose Kubernetes pod failures using context checks, events and container logs, then verify recovery without deleting evidence or guessing at fixes."
date: "2026-10-31"
kind: guide
---

This guide gives you a repeatable, read-only-first routine for Kubernetes troubleshooting. You will confirm where you are, read pod status, interpret describe output and events, pull current and previous logs, sort the failure into one of four common shapes, separate readiness problems from liveness problems, and verify that a fix actually worked. Deleting a pod is never step one here. It is never a universal fix either.

Prerequisites: kubectl installed, access to a cluster, and permission to read pods, events and pod logs. Node-level checks additionally require permission to read nodes. Everything below follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/) and kubectl reference. Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME and CONTAINER_NAME.

## Step 1: Confirm your kubectl context and namespace before anything else

Before you read a single status, find out which cluster and namespace your next command will hit. kubectl acts on whatever your current context points to, and that context is easy to forget you changed.

Run these three read-only commands:

```
kubectl config get-contexts
kubectl config current-context
kubectl config view --minify --output 'jsonpath={..namespace}'
```

The first lists every context in your kubeconfig. The second prints the active one. The third prints the namespace set on that context, and an empty result means you are in the default namespace.

Choose the intended context from `get-contexts` and pass it explicitly with `--context CONTEXT_NAME`. This avoids changing the current context stored in your local kubeconfig.

Pass `--context CONTEXT_NAME` and `-n NAMESPACE` on each namespaced command below. Replace the uppercase placeholders before running commands. `DEPLOYMENT_NAME`, `NODE_NAME`, `SERVICE_NAME` and `YOUR_LABEL` appear in later checks. A context name selects a kubeconfig entry; verify its cluster and credentials before relying on it.

Record the intended context and namespace in incident notes so teammates can repeat the same checks.

## Step 2: List pods and read the STATUS, READY and RESTARTS columns

Now list the pods. This is the cheapest and most informative command in the whole routine.

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
```

The `-o wide` flag adds the node name and pod IP, which matters later when you suspect a node problem. Read three columns first.

STATUS is the pod's phase or the reason a container is waiting. Values like Pending, ImagePullBackOff, CrashLoopBackOff, Error and Running are the starting vocabulary for Step 5.

READY is shown as ready containers over total containers, for example 1/2. A pod can be Running and still be 0/1 ready. Check container states and readiness conditions before concluding why. A Running phase does not mean every container is running or Ready; unready pods are normally excluded from Service traffic, with exceptions such as `publishNotReadyAddresses`.

RESTARTS counts container restarts. A number that keeps climbing between two runs of the command is a loop, not a one-off. Check it twice, a minute apart, and compare.

If the list is long, filter instead of scrolling:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE --field-selector=status.phase!=Running
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -l app=YOUR_LABEL
```

For a running view while you work, add `-w` to watch changes as they happen.

Hold onto this: STATUS tells you what Kubernetes thinks, not why. Never act on STATUS alone. A CrashLoopBackOff could be a bad config, a missing secret, an out-of-memory kill or a bug in the application. The next two steps are where the why lives, so resist the urge to delete or restart anything until you have read them.

## Step 3: Run kubectl describe pod and read State, Last State and Events

Pick the misbehaving pod and describe it:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

The output is long. Read it in this order, because the answer is usually in the last third.

First, the Containers section. For each container you get a State (Waiting, Running or Terminated) and, if it has restarted, a Last State. Look at the Reason and Exit Code fields. A termination reason of OOMKilled indicates an out-of-memory termination; investigate container limits, usage and node memory pressure. Exit code 137 alone does not prove an out-of-memory kill. A non-zero exit code with reason Error needs application logs and event context before assigning a cause. The Restart Count here should match what you saw in Step 2.

Second, Conditions. Look at PodScheduled, Initialized, ContainersReady and Ready, along with any additional conditions present. These are useful checkpoints, not an exhaustive ordered list of booleans. If PodScheduled is False, no node accepted it. If Ready is False while ContainersReady is True, look at readiness gates.

Third, and most valuable, the Events section at the bottom. Events are timestamped messages from the scheduler, the kubelet and other controllers. Messages like FailedScheduling, Failed to pull image, BackOff restarting failed container or Readiness probe failed name the problem in plain words.

Events have limited retention determined by the cluster configuration. Capture relevant events early:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --sort-by=.metadata.creationTimestamp
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME
```

Capture the pod UID, status, events and relevant logs before deleting anything. A replacement has a new identity; event retention and log availability vary, so deletion can make evidence harder to correlate.

## Step 4: Select the right container and read current and previous logs (and handle sensitive output)

Logs come next, and the most common mistake is reading the wrong container or the wrong instance of it.

First find the container names. A pod can hold app containers, sidecars and init containers:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.containers[*].name}'
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.initContainers[*].name}'
```

Then read the current logs for the specific container:

```
kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE -c CONTAINER_NAME --tail=200
```

If the container has crashed and restarted, the current log may be nearly empty because it just started. Ask for the previous instance:

```
kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE -c CONTAINER_NAME --previous
```

That one flag is the most useful thing to know for crash loops. The stack trace you need is in the instance that died, not the one that just booted. If an init container is stuck, pass its name to `-c` the same way. Add `--since=15m` or `--timestamps` to narrow a noisy log to the window that matters, and `-f` to follow live output.

Now the part people skip: treat the output as sensitive. Application logs routinely contain tokens, connection strings, email addresses and request bodies. Before you paste a log into a ticket, a chat thread or an AI assistant, scan it and redact secrets. Share a short excerpt instead of a full dump. The same applies to `kubectl --context CONTEXT_NAME describe`, which can reveal environment variable names and image registries.

Pick a rule and keep it: logs stay in the terminal until you have read them with redaction in mind.

## Step 5: Classify the problem: Pending, ImagePullBackOff, CrashLoopBackOff or Running but not Ready

You now have status, events and logs. Sort the problem into one of four shapes, because each has a different first suspect.

Pending means the pod was accepted but never scheduled or never started. Read the Events for FailedScheduling. Typical causes: insufficient CPU or memory on any node, an unsatisfiable node selector or taint, or a PersistentVolumeClaim that cannot bind. Check with `kubectl --context CONTEXT_NAME describe node NODE_NAME` for allocatable resources and `kubectl --context CONTEXT_NAME get pvc -n NAMESPACE` for storage. The [Pending pods guide](/blog/kubernetes-pod-pending) walks through reading FailedScheduling in full.

ImagePullBackOff (and its sibling ErrImagePull) means the node cannot fetch the image. The event text usually says why: a typo in the image name or tag, a private registry without an imagePullSecret, or a registry rate limit. Verify the exact image string in `kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.containers[*].image}'` and compare it to what exists in your registry.

CrashLoopBackOff means the container starts, exits, and Kubernetes backs off between restarts. Go back to the Last State exit code and the `--previous` logs. An OOMKilled reason calls for checking limits, measured usage and node memory pressure before changing resources. Exit 137 by itself is insufficient evidence. A config or missing-secret error shows up in the first lines of the previous log. The [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) covers exit codes and causes in depth.

Running but not Ready calls for checking individual container states, readiness probes and readiness gates. A failed readiness probe is one possible cause, not the only one. Continue with Step 6.

Classify the observed failure before changing anything. A fix that targets the wrong shape wastes time and muddies the evidence. Once you have classified it, the remedy is usually a config change, a resource change or a corrected image reference, applied through your deployment spec. It is not a manual pod deletion.

## Step 6: Tell readiness failures from liveness failures

Probes are the least understood part of pod health, and mixing them up sends people down the wrong path. The [probe documentation](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) defines the roles clearly.

A readiness probe decides whether the pod receives traffic. When it fails, the container is marked unready and the Pod Ready condition becomes false. Service routing normally excludes that unready endpoint. A failed readiness probe does not itself restart the container. If your pod is Running but not Ready and RESTARTS is flat, suspect readiness.

A liveness probe decides whether the container is alive. When it reaches its failure threshold, the kubelet terminates the container; the Pod restart policy determines restart behavior. If RESTARTS climbs and the events say Liveness probe failed, suspect liveness. A startup probe, if configured, holds off the other two while a slow application boots.

Find the evidence in two places. In describe output, look at the Liveness, Readiness and Startup lines under each container, which show the probe type, path, port, delay, timeout and period. Then read the Events for messages such as Readiness probe failed with the HTTP status or connection error.

Common causes on the readiness side: the app listens on a different port or path than the probe expects, a dependency like a database is unreachable, or the app needs longer to warm up than the initial delay allows. On the liveness side, the usual culprit is a probe that is too aggressive, so a slow but healthy app gets killed under load.

A practical rule: a liveness probe should check only whether the process itself is wedged, never a downstream dependency. If a database outage makes your liveness probe fail, Kubernetes will restart perfectly good containers and turn a partial outage into a full one. Keep dependency checks in readiness.

## Step 7: Verify the fix with rollout status, pod state and fresh logs

A fix is not a fix until you have observed it. Verification is the same read-only routine, run again, with before and after in mind.

If the change went through a Deployment, watch the rollout complete:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=120s
```

The command blocks until the rollout finishes or fails, and its exit code is usable in scripts. If it stalls, the new pods are not becoming ready, which sends you straight back to Steps 3 to 6 with the new pod name.

Then re-read pod state:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE
```

Confirm three things. STATUS is Running. READY shows all containers ready, such as 1/1. RESTARTS is stable across two checks a minute or two apart. A restart count that holds still is the real signal that a crash loop is over.

Finally, read fresh logs from the new pod:

```
kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE -c CONTAINER_NAME --since=5m
```

Look for normal startup messages and the absence of the error you were chasing. A green STATUS with the same exception repeating in the logs is a false recovery.

A rollback changes the live workload and may be unsafe after an incompatible schema or configuration change. Follow your deployment process, check compatibility and obtain the required approval before using a rollback command.

Note what changed and why in your incident notes: the symptom, the classification from Step 5, the evidence from events and logs, and the change that fixed it. That record is worth more than the fix itself the next time the same alert fires at 3 a.m.

## What to do next and troubleshooting notes

If the routine above does not give you an answer, widen the lens one layer at a time instead of jumping to drastic action.

Check the node. If several pods on the same node misbehave, run `kubectl --context CONTEXT_NAME describe node NODE_NAME` and look at Conditions such as MemoryPressure, DiskPressure and Ready. Check the controller. `kubectl --context CONTEXT_NAME describe deployment DEPLOYMENT_NAME -n NAMESPACE` shows rollout conditions and ReplicaSet events that the pod view hides. Check the network path. If pods are healthy but traffic fails, inspect the Service and its endpoints with `kubectl --context CONTEXT_NAME get endpointslices -n NAMESPACE -l kubernetes.io/service-name=SERVICE_NAME`. If no EndpointSlices appear, check the Service selector and whether a controller manages its endpoints. If slices exist, inspect each endpoint's ready, serving and terminating conditions; unready endpoints can still appear in the slice.

If you need to look inside a running container, `kubectl exec` is available, but treat it as an escalation. You are now touching a live workload, so confirm context and namespace again first.

## Conclusion

Make the routine a habit before the next incident: context, pods, describe, logs, classify, verify. Write the sequence into your runbook and put the context and namespace flags in every command. That is what separates a calm diagnosis from a destructive guess.

If you spend your days jumping between clusters, cloud consoles and terminals, Infrawrench brings Kubernetes, SSH and other infrastructure tools into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux (no account required) to manage your Kubernetes clusters alongside the rest of your infrastructure.

## References

- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Container logs reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [Readiness, liveness and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [EndpointSlice conditions](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)

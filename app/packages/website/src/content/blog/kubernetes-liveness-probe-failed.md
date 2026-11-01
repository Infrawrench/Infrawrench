---
title: "Kubernetes liveness probe failed: stop probes restarting healthy containers"
description: "Fix containers restarted by a failing Kubernetes liveness probe: confirm the probe caused the restart, test the endpoint the kubelet calls, tune timeoutSeconds and failureThreshold, and add a startup probe for slow starts."
date: "2026-11-01"
kind: guide
---

When a liveness probe fails enough times in a row, the kubelet kills the container and restarts it. That is the point of a liveness probe when the application is deadlocked. It is a problem when the application was healthy and only slow: under load, during startup, or while a dependency was having a bad minute. This guide shows how to prove a liveness probe caused a restart, test the exact check the kubelet runs, and tune the probe so it only restarts containers that are actually stuck.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods and events, exec into containers and edit the workload in the namespace. Everything here follows the official Kubernetes documentation on [liveness, readiness and startup probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME, PORT, HEALTH_PATH and DEPLOYMENT_NAME. Replace them before running a command. If the container is not being restarted but is stuck at READY 0/1, that is a readiness problem: follow the [readiness probe guide](/blog/kubernetes-readiness-probe-failed) instead.

## What a liveness probe does

The official docs describe three probes that behave differently:

- **Liveness probes decide when to restart a container.** If a container fails its liveness probe more times than the configured tolerance, the kubelet restarts that container. The pod stays on the same node, and the container's restart count goes up.
- **Readiness probes decide whether a container gets traffic.** A failing readiness probe never restarts anything; the pod is removed from Service endpoints until it passes again.
- **Startup probes protect slow starts.** If a startup probe is configured, Kubernetes runs no liveness or readiness probes until it succeeds.

Liveness probes do not wait for readiness probes to succeed. The docs also carry a warning worth taking literally: liveness probes should indicate unrecoverable application failure, such as a deadlock, and an incorrect one can cause cascading failures. Containers get restarted under high load, client requests fail, and the remaining pods take on more work, which makes their own probes slower.

## Step 1: Confirm the probe caused the restart

Check you are pointed at the right cluster and namespace, then read the pod's events:

```
kubectl config current-context
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME,reason=Unhealthy
```

A liveness restart leaves a clear trail: Warning events with the reason Unhealthy and a message starting "Liveness probe failed", followed by an event saying the container failed its liveness probe and will be restarted. The failure message usually says why: a timeout, a connection refused, an HTTP status code, or the output of an exec command.

Then check how the previous container ended:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}restarts={.restartCount}{"\t"}{.lastState.terminated.reason}{"\t"}exit={.lastState.terminated.exitCode}{"\n"}{end}'
```

If there are no liveness events and the reason is OOMKilled, the probe is not your problem: see the [OOMKilled guide](/blog/kubernetes-oomkilled). If the container exits on its own with an error, follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff). If the node evicted the whole pod, see the [evicted pods guide](/blog/kubernetes-evicted-pods).

## Step 2: Read the probe exactly as configured

Print the liveness and startup probes for each container:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{"  liveness: "}{.livenessProbe}{"\n"}{"  startup: "}{.startupProbe}{"\n"}{end}'
```

Fields left out of the spec use their defaults, so know them:

- **timeoutSeconds**: 1 second. A health endpoint that takes longer than that counts as a failure.
- **periodSeconds**: 10 seconds between checks.
- **failureThreshold**: 3 consecutive failures before the kubelet restarts the container.
- **initialDelaySeconds**: 0, so probing can start as soon as the container starts.
- **successThreshold**: must be 1 for liveness and startup probes.

With those defaults, three slow responses in a row, about 30 seconds of trouble, is enough to restart a container. One second is a tight budget for an endpoint on a busy process.

## Step 3: Test the check the kubelet runs

Each probe uses one mechanism, and each has its own rule for success:

- **httpGet**: the kubelet sends a GET to the pod's IP on the given port and path. Any status from 200 up to but not including 400 passes.
- **tcpSocket**: passes if the port accepts a connection.
- **exec**: runs a command inside the container and passes if it exits 0.
- **grpc**: passes if the gRPC health check reports SERVING.

For an HTTP probe, call the endpoint yourself from inside the container, if the image includes a client such as curl or wget, and time it:

```
kubectl --context CONTEXT_NAME exec POD_NAME -n NAMESPACE -c CONTAINER_NAME -- sh -c 'time wget -q -O /dev/null http://127.0.0.1:PORT/HEALTH_PATH'
```

If the image has no client, forward the port and call it from your machine:

```
kubectl --context CONTEXT_NAME port-forward pod/POD_NAME -n NAMESPACE 8080:PORT
```

Then request `http://localhost:8080/HEALTH_PATH` in a second terminal. If port forwarding fails, the [kubectl exec and port-forward guide](/blog/kubernetes-kubectl-exec-port-forward-errors) covers the common errors.

Things to look for:

- **It responds, but slowly.** Anything near or over `timeoutSeconds` will fail under load. This is the most common cause of restarts of healthy containers.
- **It works on 127.0.0.1 but the probe still fails.** The kubelet probes the pod's IP address, not localhost. An application that only listens on 127.0.0.1 passes your test and fails the kubelet's.
- **It returns a redirect or an error status.** A 3xx to the same host is followed; a 4xx or 5xx fails. Check the path and port match what the application really serves.
- **For exec probes, the command itself is heavy.** The docs warn that exec probes fork processes on every run, which adds CPU load on busy nodes. Prefer an HTTP, TCP or gRPC check where you can.

## Step 4: Fix the cause

Pick the fix that matches what you found. Change the probe in the workload's pod template, not the running pod.

**Slow under load.** Raise `timeoutSeconds` to cover the endpoint's real response time under load, and raise `failureThreshold` so one slow patch does not trigger a restart. Make the health endpoint cheap: it should report that the process can make progress, not do real work.

**Slow at startup.** Add a startup probe that checks the same endpoint as the liveness probe, with `failureThreshold × periodSeconds` long enough to cover the worst case startup time. The official example uses `failureThreshold: 30` and `periodSeconds: 10`, which gives the application up to five minutes to start. Once the startup probe succeeds, the liveness probe takes over with its normal settings. That is better than a long `initialDelaySeconds`, because the liveness probe stays fast for real deadlocks.

```
startupProbe:
  httpGet:
    path: /HEALTH_PATH
    port: PORT
  failureThreshold: 30
  periodSeconds: 10
```

**The check depends on something else.** If the liveness endpoint checks a database or another service, an outage there restarts every replica at once and fixes nothing. The docs suggest the liveness probe should pass when the app itself is healthy, while the readiness probe can additionally check required back-end services. That way an unavailable dependency takes pods out of traffic instead of restarting them.

**Readiness and liveness tuned the same.** A common pattern in the docs is to use the same low-cost endpoint for both, with a higher `failureThreshold` on liveness. The pod is taken out of traffic first and only restarted if the problem persists.

**Wrong address, port or path.** Make the application listen on the pod's IP rather than only 127.0.0.1, and correct the port or path in the probe.

**No liveness probe needed.** If the process exits on its own when it becomes unhealthy, the docs note you do not necessarily need a liveness probe: the kubelet already restarts it according to the pod's `restartPolicy`.

## Step 5: Verify

Roll out the change and watch the restart count:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -w
```

RESTARTS should stay flat on the new pods, including through a period of real load, since probe timeouts often only appear under load. Recheck the Unhealthy events from Step 1 after a while. If the rollout itself does not finish, the [stuck rollout guide](/blog/kubernetes-deployment-rollout-stuck) covers the Deployment side.

## Conclusion

A liveness probe should restart a container only when it is truly stuck. Confirm the restart came from the probe by reading the Unhealthy events, test the exact endpoint the kubelet calls on the pod's IP, and compare its response time with `timeoutSeconds`. Then give the probe realistic timeouts and thresholds, move slow starts into a startup probe, and keep dependency checks in readiness, not liveness.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Liveness, readiness and startup probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [Configure liveness, readiness and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Debug running pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)

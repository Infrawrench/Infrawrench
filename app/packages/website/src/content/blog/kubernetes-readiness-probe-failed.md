---
title: "Kubernetes readiness probe failed: fix pods that run but are not Ready"
description: "Fix a Kubernetes pod that is Running but not Ready by reading probe failure events, checking probe settings and readiness gates, and keeping liveness probes safe."
date: "2026-10-31"
kind: guide
---

A pod that shows Running with READY at 0/1 has started its containers, but Kubernetes will not send it traffic. Unlike a [CrashLoopBackOff](/blog/kubernetes-crashloopbackoff), nothing is restarting, so it is easy to miss until a Service has no healthy backends or a rollout stalls. This guide shows how to find which container is not ready, read the probe failure events, check the probe against what the application actually serves, and keep liveness and startup probes from turning a slow start into a restart loop.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events, Services and EndpointSlices, and to exec into pods. Everything here follows the official [Kubernetes documentation on probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME, SERVICE_NAME, PORT, PATH and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## What Running but not Ready actually means

Kubernetes has three kinds of probe, and they do different things when they fail:

- **Readiness probe**: decides whether a container should receive traffic. When it fails, the kubelet keeps the container running and keeps probing, sets the pod's Ready condition to false, and the pod's IP is removed from the EndpointSlices of every Service that matches it. Readiness probes run for the container's whole life, not just at startup.
- **Liveness probe**: decides whether a container should be restarted. When it fails enough times in a row, the kubelet kills the container and applies the pod's restart policy.
- **Startup probe**: decides whether the application has started. Until it succeeds, Kubernetes runs no liveness or readiness probes. If it fails, the kubelet kills the container.

So a pod that is Running and not Ready, with a flat restart count, is almost always a readiness problem. A pod that is not Ready and also restarting is a liveness or startup problem, and the restarts are the bigger issue.

A pod can also be not Ready with every container ready. If the pod spec has `readinessGates`, the pod is only Ready when all its containers are ready and every listed condition is True. Step 6 covers that case.

## Step 1: Find the container that is not ready

Check you are pointed at the right cluster and namespace, then list the pod:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
```

READY shows ready containers out of the total. In a pod with several containers, including sidecars, find which one is holding it back:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.ready}{"\t"}{.started}{"\t"}{.restartCount}{"\n"}{end}'
```

Then read the pod's conditions:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\n"}{end}'
```

If ContainersReady is False, a container is failing its readiness probe or has not started. If ContainersReady is True but Ready is False, the pod is waiting on a readiness gate (Step 6).

## Step 2: Read the probe failure events

Describe the pod:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

The container section shows each probe's settings on lines such as `Readiness: http-get http://:8080/healthz delay=0s timeout=1s period=10s #success=1 #failure=3`. The Events section shows the failures. Probe failures are Warning events with the reason Unhealthy and a message that names the probe:

- **Readiness probe failed**: the container stays running, out of the Service.
- **Liveness probe failed**: the kubelet will restart the container once the failure threshold is reached.
- **Startup probe failed**: the application has not finished starting within the time the probe allows.

To pull only those events:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME,reason=Unhealthy
```

The rest of the message is what the probe got back: an HTTP status code, a connection refused, a timeout, or the output of a failed command. That detail decides which step applies next.

## Step 3: Check the probe against what the app serves

Each probe uses exactly one of four checks, and each has its own idea of success:

- **httpGet**: an HTTP GET to the pod's IP on the given port and path. A status from 200 to 399 is success. Anything else, including 404 and 500, is failure.
- **tcpSocket**: success if the port accepts a connection.
- **exec**: runs a command inside the container. Exit code 0 is success.
- **grpc**: success if the gRPC health check returns SERVING.

Most readiness failures are a probe that does not match the application. Check each part:

- **Port.** The probe's port must be one the process actually listens on. A connection refused message usually means the wrong port, or an app that only listens on localhost while the probe connects to the pod's IP.
- **Path.** The `path` defaults to `/`. A 404 means the health endpoint is somewhere else, or the app serves it under a prefix.
- **Scheme.** HTTP probes default to plain HTTP. If the endpoint only answers HTTPS, set `scheme: HTTPS`.
- **Host header.** The probe connects to the pod IP. If the app routes by host name, set a Host header in `httpHeaders` rather than changing `host`.

Then test the endpoint from inside the container, so you see what the probe sees:

```
kubectl --context CONTEXT_NAME exec -n NAMESPACE POD_NAME -c CONTAINER_NAME -- wget -qO- http://127.0.0.1:PORT/PATH
```

Not every image includes wget or curl. If neither exists, read the application's logs around the time of the failures with `kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE -c CONTAINER_NAME`. If the endpoint answers inside the container but the probe still fails, compare the port and listen address with what the probe uses.

## Step 4: Check the timing settings

A correct endpoint can still fail if the probe gives up too early. The official defaults are:

- **initialDelaySeconds**: 0. Before this delay, a readiness probe counts as Failure.
- **periodSeconds**: 10. How often the probe runs.
- **timeoutSeconds**: 1. A response slower than one second is a failure.
- **failureThreshold**: 3. Consecutive failures before Kubernetes treats the check as failed.
- **successThreshold**: 1. Consecutive successes needed after a failure. It must be 1 for liveness and startup probes.

Timeouts are the most common timing problem. A health endpoint that checks a database, or an app under load or CPU throttling, can easily take more than a second. Look for timeout messages in the Unhealthy events. Raising `timeoutSeconds` is reasonable for a genuinely slow endpoint, but a health check that is slow under normal load is worth making cheaper.

Readiness that flips between ready and not ready is often the same problem at the edge: the endpoint answers just under the timeout most of the time. Check whether failures line up with load or with work the app does on a schedule.

## Step 5: Keep liveness and startup probes safe

Liveness probes need the most care, because a wrong one kills healthy containers. The official guidance is direct: liveness probes should indicate unrecoverable failure, such as a deadlock, and a badly implemented one can cause cascading failures, restarting containers under high load and pushing more work onto the pods that remain.

Three rules follow from the docs:

- **Slow starts belong in a startup probe.** If the app usually needs longer than `initialDelaySeconds + failureThreshold × periodSeconds` to start, add a startup probe that checks the same endpoint as the liveness probe, with a `failureThreshold` high enough to cover startup. Liveness checks do not begin until it succeeds, so you do not have to weaken the liveness probe to survive startup.
- **Probes do not wait for each other.** Liveness probes do not wait for readiness to succeed. Use `initialDelaySeconds` or a startup probe to delay them.
- **Give liveness more tolerance than readiness.** A common pattern is the same low-cost endpoint for both, with a higher `failureThreshold` on liveness. The pod is taken out of traffic first, and only restarted if the problem persists.

If the application crashes on its own when it becomes unhealthy, you may not need a liveness probe at all. The kubelet already handles the crash through the restart policy.

## Step 6: Readiness gates and Services

**Readiness gates.** If every container is ready but the pod is not, check the spec:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.readinessGates}{"\n"}'
```

Each gate names a condition type that something outside the kubelet, usually a controller such as a load balancer integration, must set to True in the pod's status. A gate whose condition is missing counts as False. The fix is in whatever controller owns that condition, not in the pod's probes.

**Services.** To confirm what traffic sees, list the EndpointSlices for the Service:

```
kubectl --context CONTEXT_NAME get endpointslices -n NAMESPACE -l kubernetes.io/service-name=SERVICE_NAME -o wide
```

A pod that is not Ready is not used as a ready endpoint for Service traffic. If every pod behind a Service is not Ready, the Service has nowhere to send requests, which is often the first symptom anyone reports.

## Step 7: Fix through the spec and verify

Apply the change where the workload is defined, usually the Deployment manifest or its Helm values: the probe's port, path, scheme or timing, a new startup probe, or a cheaper health endpoint in the application. Probe settings live in the pod template, so changing them rolls out new pods.

Then confirm it moved:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
kubectl --context CONTEXT_NAME get pods -n NAMESPACE
```

READY should show every container ready, RESTARTS should stay flat, and the Service's EndpointSlices should list the new pods as ready. Watch through a period of real load, since timeouts that only appear under load will not show in the first minute. If the container now restarts instead, follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff). If it is being killed for memory, see the [OOMKilled guide](/blog/kubernetes-oomkilled).

Write down the Unhealthy message and the change that fixed it. The next probe failure will take a minute to resolve.

## Conclusion

Running but not Ready means the container is alive and Kubernetes is keeping traffic away from it. Find the container that is not ready, read the Unhealthy events, check the probe's port, path, scheme and timeout against what the app actually serves, and keep liveness probes for real deadlocks. If every container is ready and the pod is not, look at its readiness gates.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Liveness, readiness and startup probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [Configure liveness, readiness and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Pod lifecycle: pod readiness](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-readiness-gate)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)

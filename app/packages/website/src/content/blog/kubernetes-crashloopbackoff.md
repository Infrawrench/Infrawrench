---
title: "Kubernetes CrashLoopBackOff: find the cause and fix it"
description: "Work out why a Kubernetes container is stuck in CrashLoopBackOff using exit codes, previous logs and events, then fix the cause instead of restarting pods."
date: "2026-10-31"
kind: guide
---

CrashLoopBackOff is one of the most common states you will see in `kubectl get pods`, and one of the least specific. It tells you a container keeps exiting and Kubernetes is waiting longer between each restart. It does not tell you why. This guide walks through a read-only routine that finds the why: the last termination state, the exit code, the logs of the instance that died, and the events around it. Then it maps the evidence to the usual causes and shows how to confirm the fix.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events and pod logs. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME and DEPLOYMENT_NAME. Replace them before running a command. For the broader routine, see the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## What CrashLoopBackOff actually means

CrashLoopBackOff is not a pod phase. It is the reason a container is in the Waiting state. The pod's phase usually still reads Running, because the pod is scheduled and the kubelet keeps trying to start the container.

The loop works like this. The container starts, its main process exits, and the pod's `restartPolicy` tells the kubelet to start it again. Deployments, StatefulSets and DaemonSets always use `restartPolicy: Always`, so any exit, including a clean exit with code 0, triggers a restart. To avoid hammering a broken container, the kubelet waits between restarts with an exponential back-off. By default the delay starts at 10 seconds, doubles each time and is capped at five minutes. It resets once a container has run for 10 minutes without problems. That is why a crash-looping pod can look idle for minutes at a time: it is waiting out the back-off, not recovering.

The practical consequence: restarting or deleting the pod does not fix anything. A new pod runs the same image with the same configuration and crashes the same way. You need the cause.

## Step 1: Confirm the loop and capture the evidence

Check you are pointed at the right cluster and namespace, then list the pods:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pods -n NAMESPACE
```

Look at STATUS and RESTARTS. Run the command again a minute later. A RESTARTS count that keeps climbing confirms a loop rather than a single crash. If STATUS reads `Init:CrashLoopBackOff`, the failing container is an init container, and the app containers have not started at all.

Before changing anything, save the pod's current state so you can compare later:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o yaml > pod-before.yaml
```

## Step 2: Read the last termination state and exit code

The single most useful piece of evidence is how the previous instance ended. Describe the pod:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Under the failing container, find Last State. It shows Terminated with a Reason, an Exit Code, and Started and Finished times. To pull only that block:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.lastState.terminated.reason}{"\t"}{.lastState.terminated.exitCode}{"\n"}{end}'
```

For an init container, swap `containerStatuses` for `initContainerStatuses`.

Read the exit code as a first clue, not a verdict. Codes above 128 conventionally mean the process was ended by a signal, where the code minus 128 is the signal number. The common ones:

- **0**: the process exited successfully. With `restartPolicy: Always`, a container whose main process finishes its work and exits will still loop. Suspect a command that runs once, or a process that forks into the background and returns.
- **1** or another small number: the application reported an error. The logs from Step 3 usually say what.
- **126** and **127**: by shell convention, the command was not executable or was not found. Suspect the `command` or `args` in the spec, or an entrypoint missing from the image.
- **137**: the process received SIGKILL. If Reason is OOMKilled, the container hit its memory limit. If Reason is Error, something else sent the kill, such as a liveness probe failure that ran past its grace period. Code 137 alone does not prove an out-of-memory kill.
- **143**: the process received SIGTERM, often during a liveness-probe restart or a normal shutdown.

Also compare Started and Finished. A container that dies within a second or two points at configuration, the command or a missing file. One that runs for minutes before dying points at memory growth, a probe, or a dependency that drops out.

## Step 3: Read the logs of the instance that died

The current container has only just started, so its log is often empty or shows only startup lines. Ask for the previous instance:

```
kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE -c CONTAINER_NAME --previous
```

The `--previous` flag is the key to crash loops. The stack trace, the "missing environment variable" message or the "connection refused" line lives in the instance that exited. Read the last 30 lines first; the fatal error is usually near the end.

If `--previous` returns nothing, the process likely died before writing anything. That points back to the exit code: a missing binary (127), a permission problem, or an immediate memory kill.

Treat log output as sensitive. Logs often contain tokens, connection strings and customer data. Redact before pasting into a ticket, a chat thread or an AI assistant.

## Step 4: Read the events

Events show what the kubelet saw around each restart:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME --sort-by=.lastTimestamp
```

The message "Back-off restarting failed container" only confirms the loop. The useful events are the ones next to it: "Liveness probe failed" means the kubelet itself is killing the container. Events about volume mounts or secrets point at configuration. Events have limited retention, so capture them early.

## Step 5: Match the evidence to the cause

With the exit code, the previous logs and the events in hand, most crash loops fall into one of these:

**Bad or missing configuration.** The previous log names a missing environment variable, an unparseable config file or a wrong path. Compare the env, ConfigMap and Secret references in the spec against what exists in the namespace. Note that a reference to a ConfigMap or Secret that does not exist usually stops the container from being created at all: CreateContainerConfigError for an environment reference, or a pod stuck in ContainerCreating with a mount event for a volume, rather than CrashLoopBackOff. A crash loop means the object exists but a value inside it is wrong or missing.

**Wrong command or entrypoint.** Exit code 126 or 127, often with an empty previous log. Check the `command` and `args` fields against the image's actual entrypoint. A common slip is setting `command` when you meant `args`, which replaces the image's entrypoint instead of passing it arguments.

**Out of memory.** Reason OOMKilled. Compare the container's memory limit with what the application actually uses at startup and under load. Raise the limit or fix the memory growth; lowering load is a workaround, not a fix. The [OOMKilled guide](/blog/kubernetes-oomkilled) covers telling a limit kill from node pressure or an eviction.

**Liveness probe killing a healthy app.** Events show "Liveness probe failed" before each restart, and the app's own logs look normal until it is stopped. Check the probe's path, port, `initialDelaySeconds`, `timeoutSeconds` and `failureThreshold`. Slow-starting apps should use a [startup probe](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) so liveness checks do not begin until the app is up. A liveness probe should never depend on a downstream service.

**A dependency that is not there.** The previous log shows "connection refused", a DNS failure or a timeout to a database or API, and the app exits instead of retrying. Check that the dependency's Service exists and has ready endpoints. The durable fix is an application that retries with back-off rather than exiting on the first failure.

**Permissions and security settings.** The previous log shows "permission denied" or "read-only file system". Check `securityContext` settings such as `runAsNonRoot`, `runAsUser` and `readOnlyRootFilesystem` against what the image expects to write and where.

**A process that exits on purpose.** Exit code 0, short runtime. The container ran a one-off task. If it is meant to run once, it belongs in a Job, not a Deployment; the [Job failure guide](/blog/kubernetes-job-failed) covers how Jobs retry and fail. If it is meant to keep running, make sure the main process stays in the foreground.

## Step 6: When the logs are not enough, debug a copy

If the container crashes too fast to inspect, run a copy of the pod with its command replaced by a shell, so you can look around inside the same image and configuration:

```
kubectl --context CONTEXT_NAME debug POD_NAME -n NAMESPACE -it --copy-to=POD_NAME-debug --container=CONTAINER_NAME -- sh
```

This creates a new pod, so treat it as an escalation and follow your team's rules for changes in that namespace. Inside, check that files and environment variables are where the app expects them, and run the original entrypoint by hand to see the error directly. If the image has no shell, the [debugging guide](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/) shows how to attach an ephemeral debug container instead. Delete the copy when you are done:

```
kubectl --context CONTEXT_NAME delete pod POD_NAME-debug -n NAMESPACE
```

## Step 7: Fix through the spec and verify

Apply the fix where the workload is defined, usually the Deployment manifest or its Helm values, not by editing or deleting the live pod. Then watch the rollout:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
kubectl --context CONTEXT_NAME get pods -n NAMESPACE
```

Confirm STATUS is Running, READY shows every container ready, and RESTARTS holds still across two checks a few minutes apart. Because the back-off can hold a container for up to five minutes, give a slow loop time to prove it has stopped. If the new pod sits in Pending instead of starting, the problem has moved to scheduling: follow the [Pending pods guide](/blog/kubernetes-pod-pending). Finally, read fresh logs from the new pod and make sure the error you were chasing is gone, not just quieter.

Write down the exit code, the log line and the change that fixed it. The next CrashLoopBackOff with the same signature will take minutes instead of an afternoon.

## Conclusion

CrashLoopBackOff is a symptom, not a diagnosis. Read how the last instance ended, read its logs with `--previous`, read the events, then fix the cause in the spec. Restarting the pod only resets the clock.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debug running pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Pod lifecycle: container restart policy](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Configure liveness, readiness and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [kubectl logs reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)

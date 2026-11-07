---
title: "Kubernetes pod stuck in Init: debug Init:0/1, Init:Error and Init:CrashLoopBackOff"
description: "Fix a pod that never gets past its init containers by reading Init:N/M status, finding the init container that is stuck or failing, reading its logs and matching the cause: a dependency it waits for, a failing script, an image pull or a missing volume."
date: "2026-11-07"
kind: guide
---

You deploy, and the pod sits at `Init:0/1` for minutes, or flips between `Init:Error` and `Init:CrashLoopBackOff`. Your application container has not started, so its logs are empty and there is nothing obvious to read. The pod is waiting on an init container: a container that must run to completion before the app containers start. This guide shows how to find which init container is holding the pod, read what it is doing, and fix the cause.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events and pod logs. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/debug/debug-application/debug-init-containers/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, INIT_CONTAINER_NAME, SERVICE_NAME and DEPLOYMENT_NAME. Replace them before running a command. For the general routine when you are not sure where a pod is stuck, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How init containers run

Init containers are listed under `initContainers` in the pod spec. The kubelet waits until the pod's networking and storage are ready, then runs them one at a time, in the order they appear. Each one must exit successfully before the next starts. Only when all of them have finished do the app containers start.

Two rules explain most stuck pods:

- An init container that never exits holds the pod forever. A script that loops until a Service exists, a database answers or a file appears will wait as long as that condition stays false.
- An init container that exits with an error is retried. With the pod's `restartPolicy` set to `Always`, as it is for Deployments, init containers behave as `OnFailure`: the kubelet restarts the failing one with a growing back-off, which is the `Init:CrashLoopBackOff` you see. With `restartPolicy: Never`, a failed init container fails the whole pod.

While init containers run, the pod's phase is `Pending` and its `Initialized` condition is `False`. Init containers cannot have a readiness probe, so the pod cannot be Ready until every init container has succeeded.

## Step 1: Read the Init status

Check you are pointed at the right cluster, then read the pod's status:

```
kubectl config current-context
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME
```

The STATUS column tells you where initialization is:

```
NAME       READY   STATUS     RESTARTS   AGE
POD_NAME   0/1     Init:1/2   0          7s
```

- `Init:N/M`: the pod has M init containers and N have completed so far.
- `Init:Error`: an init container has failed to execute.
- `Init:CrashLoopBackOff`: an init container has failed repeatedly.
- `Pending`: the pod has not yet begun executing init containers.
- `PodInitializing` or `Running`: the pod has finished executing init containers.

`Init:0/1` with zero restarts means the first init container is running and has not exited. A status like `Init:ImagePullBackOff` names the waiting reason of the init container itself, so treat it the same way you would for an app container.

## Step 2: Find the init container that is stuck

Describe the pod and read the Init Containers section:

```
kubectl --context CONTEXT_NAME -n NAMESPACE describe pod POD_NAME
```

Each init container shows its state, last state, exit code and restart count:

```
Init Containers:
  init-migrate:
    State:          Terminated
      Reason:       Completed
      Exit Code:    0
    Ready:          True
    Restart Count:  0
  init-wait-db:
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
    Ready:          False
    Restart Count:  3
```

The first init container that is not `Terminated` with reason `Completed` is the one holding the pod. Everything after it shows `Waiting` with reason `PodInitializing`, which only means it has not had its turn. Read the Events at the bottom of the same output too: scheduling, image pulls and volume mounts for init containers are reported there, with the container named as `spec.initContainers{INIT_CONTAINER_NAME}`.

To read the same states without the rest of the describe output:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -o jsonpath='{range .status.initContainerStatuses[*]}{.name}{"\t"}{.state}{"\t"}{.restartCount}{"\n"}{end}'
```

## Step 3: Read the init container's logs

Pass the init container's name with `-c`:

```
kubectl --context CONTEXT_NAME -n NAMESPACE logs POD_NAME -c INIT_CONTAINER_NAME
```

If it has restarted, the current attempt may have printed nothing yet. Read the attempt that failed:

```
kubectl --context CONTEXT_NAME -n NAMESPACE logs POD_NAME -c INIT_CONTAINER_NAME --previous
```

Add `-f` to follow an init container that is still running. If the script prints nothing useful, the Kubernetes docs suggest starting shell scripts with `set -x` so each command is printed as it runs.

## Step 4: Match the cause

### It is waiting for a Service, database or another dependency

The most common `Init:0/1` that never moves. A typical init container loops on something like:

```
until nslookup SERVICE_NAME.NAMESPACE.svc.cluster.local; do echo waiting for SERVICE_NAME; sleep 2; done
```

The logs repeat the same waiting line. Check that what it waits for exists and is spelled the same way, in the namespace the script uses:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get service SERVICE_NAME
kubectl --context CONTEXT_NAME -n NAMESPACE get endpointslices -l kubernetes.io/service-name=SERVICE_NAME
```

No Service means it was never created, has a different name, or lives in another namespace. A Service with no ready endpoints means the backing pods are not Ready: follow the [Service has no endpoints guide](/blog/kubernetes-service-no-endpoints). If the Service exists but the name does not resolve from inside the pod, the problem is DNS: see [DNS not working](/blog/kubernetes-dns-troubleshooting). If a NetworkPolicy applies to the pod, the init container is subject to it too, so check whether egress to the dependency or to DNS is allowed: see [NetworkPolicy blocking traffic](/blog/kubernetes-networkpolicy-blocking-traffic).

### The script exits with an error

`Init:Error` or `Init:CrashLoopBackOff` with a non-zero exit code and an error in `--previous` logs. Fix what the logs name: a migration that fails, a wrong command, a missing environment variable, a permission error writing to a volume. Exit code 137 with reason `OOMKilled` means the init container hit its memory limit: see [out-of-memory kills](/blog/kubernetes-oomkilled).

Init containers can run more than once. If the pod restarts, all of them run again, so their code should be idempotent. A script that writes into an `emptyDir` volume should expect that its output file may already exist from an earlier attempt and not fail on it.

### The image will not pull

`Init:ErrImagePull` or `Init:ImagePullBackOff`, with failed pull events for `spec.initContainers{INIT_CONTAINER_NAME}`. Init containers often use a different image from the app, sometimes from a different registry, so the app image pulling fine proves nothing. Follow the [image pull errors guide](/blog/kubernetes-imagepullbackoff) using the init container's image.

### A volume, ConfigMap or Secret is missing

If the pod never gets as far as starting the first init container and events show `FailedMount`, the kubelet is still waiting for storage, which it needs before any init container runs. See [pod stuck in ContainerCreating](/blog/kubernetes-pod-stuck-containercreating). If the event says a ConfigMap or Secret key referenced in the init container's environment does not exist, see [CreateContainerConfigError](/blog/kubernetes-createcontainerconfigerror).

### The pod is Pending and no init container has started

If the status is plain `Pending` with a `FailedScheduling` event, the scheduler has not placed the pod. Init container requests count here: the pod's effective request is the higher of the largest init container request and the sum of the app container requests. A large memory request on an init container can keep a pod from fitting on any node even though it only needs that memory briefly. Read the event and see [pod stuck in Pending](/blog/kubernetes-pod-pending).

## Step 5: Fix it and let the pod restart

Fix the dependency, script, image or reference, then let the controller replace the pod. For a Deployment, apply the corrected manifest, or once the dependency exists, restart the rollout so new pods run the init containers again:

```
kubectl --context CONTEXT_NAME -n NAMESPACE rollout restart deployment DEPLOYMENT_NAME
```

Editing the init container in a running pod is limited to its `image` field, and changing it does not restart the pod. Change the pod template in the Deployment, StatefulSet or Job instead.

To stop an init container from waiting forever, put a limit inside the script, for example a loop that tries 100 times and then exits with an error, so a missing dependency shows up as `Init:Error` rather than a silent `Init:0/1`. The Kubernetes docs also mention `activeDeadlineSeconds` on the pod, which includes time spent in init containers, but recommend it only for pods run by Jobs, because it also kills a pod that is already running correctly once the deadline passes.

## Step 6: Verify

Watch the pod move through its init containers:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -w
```

The status should go from `Init:0/2` to `Init:1/2`, then `PodInitializing`, then `Running`. Confirm the `Initialized` condition is `True`:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -o jsonpath='{.status.conditions[?(@.type=="Initialized")].status}{"\n"}'
```

If the app container now fails instead, the init containers are no longer the problem: continue with [CrashLoopBackOff](/blog/kubernetes-crashloopbackoff) or [readiness probe failed](/blog/kubernetes-readiness-probe-failed).

## Conclusion

A pod stuck in Init is waiting on one init container. Read `Init:N/M` to see how far it got, describe the pod to find the first init container that has not completed, and read its logs with `-c` and `--previous`. Most cases are a dependency that does not exist or is not reachable, a script that fails, an image that will not pull, or a volume that is not ready. Give waiting scripts a limit so the next failure is loud instead of silent.

If you are switching between kubectl contexts, cloud consoles and database clients to chase down a dependency an init container is waiting on, Infrawrench brings Kubernetes exec and logs, SSH and SQL into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug Init Containers](https://kubernetes.io/docs/tasks/debug/debug-application/debug-init-containers/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Configure Pod Initialization](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-initialization/)
- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)

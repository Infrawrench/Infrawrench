---
title: "kubectl exec and port-forward not working: fix the common errors"
description: "Fix kubectl exec and kubectl port-forward failures: wrong container, no shell in the image, pods that are not running, refused connections and missing RBAC permissions."
date: "2026-11-01"
kind: guide
---

`kubectl exec` and `kubectl port-forward` are how most people get inside a running workload: a shell to look around, or a local port that reaches a database or admin page in the cluster. When they fail, the error often says little about why. This guide walks through the usual causes in the order worth checking them: is the pod actually running, did you pick the right container, does the command exist in the image, are you allowed to do this, and is anything listening on the port you are forwarding to.

Prerequisites: kubectl installed and access to the cluster. Everything here follows the official Kubernetes documentation for [getting a shell to a running container](https://kubernetes.io/docs/tasks/debug/debug-application/get-shell-running-container/) and [using port forwarding](https://kubernetes.io/docs/tasks/access-application-cluster/port-forward-access-application-cluster/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME, LOCAL_PORT and REMOTE_PORT. Replace them before running a command. For the broader routine, see the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How exec and port-forward work

Both commands go through the Kubernetes API server, not straight to the pod. kubectl asks the API server for a subresource of the pod, `pods/exec` or `pods/portforward`, and the API server checks your permissions and passes the stream on to the kubelet on the pod's node. That has three practical consequences:

- The pod has to be running on a node. There is nothing to exec into or forward to in a pod that is Pending, or in a container that is not running.
- Your permission to read a pod is not the same as permission to exec into it or forward to it. They are separate checks.
- Neither command needs a network path from your laptop to the pod. Port-forward works for a pod with no Service and no ingress, as long as you can reach the API server.

## Step 1: Confirm the pod and container are running

Check you are pointed at the right cluster and namespace, then look at the pod:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE
```

STATUS should be Running and READY should show the container you want as ready. If the pod is Pending, it has not been scheduled; follow the [Pending pods guide](/blog/kubernetes-pod-pending). If it is in CrashLoopBackOff, the container keeps exiting, so an exec session will be cut off or refused each time it dies; follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) and read logs with `--previous` instead. A pod that has completed, such as a finished Job pod, has no running container to exec into.

Both commands wait up to one minute by default for a pod to be running before giving up. The `--pod-running-timeout` flag changes that, which helps when you exec into a pod that is still starting.

## Step 2: Pick the right container

In a pod with more than one container, kubectl uses the container named in the `kubectl.kubernetes.io/default-container` annotation, or the first container in the pod if there is none. That may be a sidecar rather than your app. List the container names:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.containers[*].name}'
```

Then name the one you want with `-c` or `--container`:

```
kubectl --context CONTEXT_NAME exec -it POD_NAME -n NAMESPACE -c CONTAINER_NAME -- /bin/sh
```

Note the double dash. Everything after `--` is the command to run in the container; everything before it is for kubectl. Leaving it out, or putting kubectl flags after it, is a common reason exec runs the wrong thing or rejects its arguments.

## Step 3: When the image has no shell

If exec fails with an error like this, the command you asked for does not exist inside the image:

```
OCI runtime exec failed: exec failed: ... "exec: \"sh\": executable file not found in $PATH": unknown
```

Try `/bin/sh` if you asked for `/bin/bash`; many small images only have one. If neither exists, the image is likely a minimal or distroless image built without a shell or debugging tools, and exec cannot help.

Use an ephemeral debug container instead. It adds a temporary container with the tools you choose to the running pod, without restarting it:

```
kubectl --context CONTEXT_NAME debug -it POD_NAME -n NAMESPACE --image=busybox:1.28 --target=CONTAINER_NAME
```

The `--target` flag puts the debug container in the process namespace of your app container, so `ps` shows its processes. If your container runtime does not support `--target`, the debug container may start with an isolated process namespace, or not start at all.

Ephemeral containers change the live pod: they cannot be removed once added, and they are never restarted. Treat this as an escalation and follow your team's rules for that namespace. If you would rather not touch the running pod, the [debugging guide](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/) shows how to debug a copy of the pod with `kubectl debug --copy-to` instead.

## Step 4: Check your permissions

A "forbidden" error means the API server refused the request. Ask it directly what you are allowed to do:

```
kubectl --context CONTEXT_NAME auth can-i get pods -n NAMESPACE
kubectl --context CONTEXT_NAME auth can-i create pods --subresource=exec -n NAMESPACE
kubectl --context CONTEXT_NAME auth can-i create pods --subresource=portforward -n NAMESPACE
```

Port-forward needs `get` on `pods` and `create` on `pods/portforward`. Exec is checked against the `pods/exec` subresource in the same way. Ephemeral debug containers are a separate subresource again, `pods/ephemeralcontainers`, so being able to exec does not mean you can use `kubectl debug`.

If any answer is "no", ask a cluster admin for the specific permission in that namespace rather than a broad role. Exec lets someone run commands inside your workloads, and the port forwarding documentation warns that forwarding can give direct network access to workloads and bypass network-level controls. Both deserve tight scoping.

## Step 5: When port-forward starts but connections fail

A working forward prints lines like these and then waits; it does not return to the prompt:

```
Forwarding from 127.0.0.1:LOCAL_PORT -> REMOTE_PORT
Forwarding from [::1]:LOCAL_PORT -> REMOTE_PORT
```

If it fails before that, check the local side. The local port may already be in use on your machine. Pick another, or leave the local port empty and let kubectl choose a free one:

```
kubectl --context CONTEXT_NAME port-forward pod/POD_NAME -n NAMESPACE :REMOTE_PORT
```

If the forward is up but your client cannot connect, check the remote side:

**Wrong remote port.** REMOTE_PORT is the port the container listens on, not the Service's port. When you forward to `service/NAME`, kubectl picks a pod behind that Service and connects to it directly, so a Service that maps port 80 to container port 8080 still needs the right mapping. Read the container port from the spec:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.containers[*].ports[*].containerPort}'
```

**Nothing listening yet.** The app may still be starting, or may have failed to bind. Check the container's logs, and if the image has a shell, exec in and look at what is listening.

**Not TCP.** Port forwarding only supports TCP. A UDP service, such as some DNS or metrics setups, cannot be reached this way.

**Reaching it from another machine.** By default port-forward listens only on localhost. `--address` changes that, but anything you bind to a wider address is open to whoever can reach your machine.

**The forward dropped.** Even when you name a Deployment or Service, port-forward connects to one matching pod. If that pod is deleted or replaced by a rollout, start the forward again.

## Step 6: Verify and clean up

Once exec works, confirm you are in the right place before changing anything:

```
kubectl --context CONTEXT_NAME exec POD_NAME -n NAMESPACE -c CONTAINER_NAME -- env
```

For port-forward, connect with your client to `localhost:LOCAL_PORT` and run a harmless read, such as a ping or a status query.

Stop port-forward sessions you no longer need with Ctrl+C. Delete any debug copy of a pod you created. Remember that anything you change inside a container through exec is lost when the pod is replaced, and is not reflected in your manifests; make lasting fixes in the spec.

Treat what you see as sensitive. Environment variables and files inside a container often hold credentials. Redact before pasting output into a ticket, a chat thread or an AI assistant.

## Conclusion

Most exec and port-forward failures come down to five things: the pod is not running, the wrong container was picked, the image has no shell, you lack the subresource permission, or nothing is listening on the remote port. Check them in that order and the error usually explains itself.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Get a shell to a running container](https://kubernetes.io/docs/tasks/debug/debug-application/get-shell-running-container/)
- [Use port forwarding to access applications in a cluster](https://kubernetes.io/docs/tasks/access-application-cluster/port-forward-access-application-cluster/)
- [Debug running pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Ephemeral containers](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Authorization: checking API access](https://kubernetes.io/docs/reference/access-authn-authz/authorization/)
- [kubectl exec reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_exec/)
- [kubectl port-forward reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_port-forward/)

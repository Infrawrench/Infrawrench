---
title: "Kubernetes CreateContainerConfigError: fix missing ConfigMaps, Secrets and keys"
description: "Fix a Kubernetes pod stuck in CreateContainerConfigError by finding the missing ConfigMap, Secret or key in the events, then creating it, fixing the reference or marking it optional."
date: "2026-10-31"
kind: guide
---

A pod in CreateContainerConfigError has been scheduled and its image is ready, but the kubelet cannot build the container's configuration. Almost always, the pod refers to a ConfigMap or Secret, or a key inside one, that the kubelet cannot find. Nothing has run yet, so there are no logs. This guide shows how to read the event that names what is missing, check it against what exists in the namespace, and fix the reference so the pod starts on its own.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events and ConfigMaps, and to list Secrets in the namespace. Everything here follows the official Kubernetes documentation on [ConfigMaps](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/) and [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONFIGMAP_NAME, SECRET_NAME, KEY_NAME and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## What CreateContainerConfigError actually means

The official docs state the rules plainly:

- **References are required by default.** If a pod refers to a ConfigMap that does not exist and the reference is not marked optional, the pod will not start. None of a pod's containers start until every non-optional Secret it uses is available.
- **Keys count too.** A reference to a key that does not exist in a ConfigMap prevents the pod from starting, unless that key reference is marked optional. A pod that refers to a missing key in a Secret that does exist fails during startup.
- **Namespaces are a hard boundary.** Pods can only refer to ConfigMaps in their own namespace. Secret references in a pod spec have no namespace field either, so they also resolve in the pod's own namespace.

When the problem is in environment variables (`env` with `configMapKeyRef` or `secretKeyRef`, or `envFrom`), kubectl usually shows the container waiting with the reason CreateContainerConfigError. When the problem is in a volume that mounts a ConfigMap or Secret, the pod usually sits in ContainerCreating with mount failure events instead. The fix is the same: make the reference point at something that exists.

The kubelet keeps retrying. Once the missing object or key appears, the pod starts without being deleted.

## Step 1: Confirm the waiting reason

Check you are pointed at the right cluster and namespace, then list the pod and each container's waiting reason:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.initContainerStatuses[*]}init:{.name}{"\t"}{.state.waiting.reason}{"\t"}{.state.waiting.message}{"\n"}{end}{range .status.containerStatuses[*]}{.name}{"\t"}{.state.waiting.reason}{"\t"}{.state.waiting.message}{"\n"}{end}'
```

The waiting message often names the problem directly, for example the ConfigMap or the key that was not found. Init containers count too: one that cannot be configured holds up the whole pod.

## Step 2: Read the events

Describe the pod and read the Events section:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Or list only this pod's events:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME
```

The kubelet records an event when it cannot fetch a Secret, with the details of the problem. Look for messages naming a ConfigMap or Secret that was not found, or a key that was not found inside one. For volume mounts, look for mount failure events that name the volume. Write down the exact name and, where given, the key.

## Step 3: List every reference the pod makes

The error names one missing piece, but a pod often references several. Fixing one can reveal the next, so list them all now. Print the environment references:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{"  env: "}{.env}{"\n"}{"  envFrom: "}{.envFrom}{"\n"}{end}'
```

And the volumes:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.volumes[*]}{.name}{"\t"}{.configMap}{"\t"}{.secret}{"\t"}{.projected}{"\n"}{end}'
```

Look for four shapes:

- `configMapKeyRef` and `secretKeyRef` under `env`: one key from one object.
- `configMapRef` and `secretRef` under `envFrom`: every key of one object.
- `configMap` and `secret` volumes, which may list specific `items` keys.
- `projected` volumes, which combine several sources.

Note which ones carry `optional: true`. Those cannot cause this error.

## Step 4: Check what actually exists

List what is in the pod's namespace, not the one you happen to be in:

```
kubectl --context CONTEXT_NAME get configmaps -n NAMESPACE
kubectl --context CONTEXT_NAME get secrets -n NAMESPACE
```

If the object exists, list its keys:

```
kubectl --context CONTEXT_NAME get configmap CONFIGMAP_NAME -n NAMESPACE -o jsonpath='{.data}{"\n"}{.binaryData}{"\n"}'
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
```

The Secret command prints key names only, not values. Avoid printing Secret values or running `-o yaml` on a Secret in a shared terminal, because the values in that output are only base64 encoded, which anyone can decode. Anyone who can create pods in a namespace can read every Secret in it, so treat that access as sensitive too.

The common mismatches:

- **The object is in another namespace.** A ConfigMap created in `default` does nothing for a pod in `production`. Create it in the pod's namespace.
- **The name differs.** A suffix added by a tool, a Helm release prefix, or a typo between the object and the reference.
- **The key differs.** `DATABASE_URL` in the reference, `database_url` or `database-url` in the object. Key names are case sensitive.
- **The object has not been created yet.** It is applied by a later step of a pipeline, a separate chart, or an operator that has not run. The official docs say the object must exist before the pod that depends on it.

## Step 5: Fix the reference

Pick the fix that matches what Step 4 found:

- **Create the missing object** in the pod's namespace, or add the missing key to the existing one. Do this through whatever owns the object, such as your manifests, Helm chart or secret manager integration, so it does not disappear on the next deploy.
- **Correct the reference** in the workload's pod template if the object exists under a different name or key.
- **Mark it optional** only if the application genuinely works without it. With `optional: true`, a missing ConfigMap or Secret is ignored, and for volumes Kubernetes still creates the mount path, which stays empty. An optional reference turns a clear startup failure into a running pod with missing configuration, so use it deliberately.

For a missing object or key, you do not need to touch the pod. The kubelet retries, and the container starts once the reference resolves. For a corrected reference, change the Deployment's pod template, which rolls out new pods.

## Step 6: Related problems that look similar

**Invalid variable names from envFrom.** With `envFrom`, keys that are not valid environment variable names are skipped rather than failing the pod. The pod starts, and a Warning event with the reason InvalidEnvironmentVariableNames lists the skipped keys. If an expected variable is missing at runtime, check for that event.

**Updates that do not show up.** ConfigMap values used as environment variables are not updated in a running container: the pod must restart to see a new value. Values mounted as a volume are updated eventually, except when mounted with `subPath`, which never receives updates. If you fixed a value and the application still sees the old one, restart the workload:

```
kubectl --context CONTEXT_NAME rollout restart deployment/DEPLOYMENT_NAME -n NAMESPACE
```

**Static pods.** Static pods cannot use ConfigMaps, because the kubelet does not support it.

## Step 7: Verify

Watch the pod leave the waiting state:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -w
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
```

STATUS should move to Running and READY should show every container ready. If the container now starts and then exits, the configuration is being read and something in it is wrong for the application: follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff). If it runs but never becomes Ready, see the [readiness probe guide](/blog/kubernetes-readiness-probe-failed).

Write down which reference was missing and why, especially when it was an ordering problem in the deploy pipeline. That is the part that will happen again.

## Conclusion

CreateContainerConfigError means the pod points at configuration that is not there. Read the event to get the exact name and key, list every reference the pod makes, compare them with what exists in the pod's own namespace, then create the missing piece or fix the reference. The kubelet retries on its own, so the pod starts as soon as the reference resolves.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Configure a pod to use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Distribute credentials securely using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)

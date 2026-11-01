---
title: "Kubernetes ConfigMap or Secret changes not picked up by pods: why and how to fix it"
description: "Fix pods that keep the old value after you update a ConfigMap or Secret: environment variables need a restart, mounted files update eventually, subPath mounts never update, and immutable objects must be replaced."
date: "2026-11-01"
kind: guide
---

You updated a ConfigMap or Secret, the object shows the new value, and the application still behaves as if nothing changed. Kubernetes did not lose the update. How a pod sees a change depends entirely on how the pod consumes the object: as environment variables, as a mounted volume, or as a single file mounted with `subPath`. This guide shows how to work out which of those your pod uses, what the official documentation says each one does on an update, and how to get the new value into the running workload.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, ConfigMaps and Secrets, and to restart the workload in the namespace. Everything here follows the official Kubernetes documentation on [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/) and [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONFIGMAP_NAME, SECRET_NAME, CONTAINER_NAME, MOUNT_PATH and DEPLOYMENT_NAME. Replace them before running a command. If the pod never starts at all because a ConfigMap, Secret or key is missing, follow the [CreateContainerConfigError guide](/blog/kubernetes-createcontainerconfigerror) instead.

## How each way of consuming configuration behaves on an update

The official docs set out four rules:

- **Environment variables are read once.** ConfigMaps consumed as environment variables are not updated automatically and require a pod restart. The same applies to Secrets: if a container already consumes a Secret in an environment variable, it will not see an update unless it is restarted. This covers `env` with `configMapKeyRef` or `secretKeyRef`, and `envFrom`.
- **Mounted volumes update eventually.** When a ConfigMap or Secret consumed in a volume is updated, the projected keys are eventually updated as well. The kubelet checks on every periodic sync, but it reads the value from a local cache, so the delay can be as long as the kubelet sync period plus the cache propagation delay.
- **subPath mounts never update.** A container using a ConfigMap or Secret as a `subPath` volume mount does not receive updates.
- **Immutable objects cannot change.** A ConfigMap or Secret marked `immutable: true` cannot have its data changed, and the change cannot be reverted. You can only delete and recreate it.

There is a fifth case that is not Kubernetes at all: the file in the container did change, but the application read it once at startup and never reads it again. Kubernetes updating the file does not make the process reload it.

## Step 1: Confirm the object holds the new value

Check you are pointed at the right cluster and namespace, then read the object the pod actually references:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get configmap CONFIGMAP_NAME -n NAMESPACE -o jsonpath='{.data}{"\n"}'
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
```

The Secret command prints key names only. Avoid printing Secret values in a shared terminal, because they are only base64 encoded.

Make sure you edited the object in the pod's namespace and under the name the pod references. If you deploy with Kustomize, its generated ConfigMaps and Secrets have a content hash suffix appended, so changing the contents produces a new object with a new name. The pod keeps the old one until its template points at the new name.

## Step 2: Find out how the pod consumes it

Print the environment references for each container:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{"  env: "}{.env}{"\n"}{"  envFrom: "}{.envFrom}{"\n"}{end}'
```

Then the volumes and where each container mounts them:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.volumes[*]}{.name}{"\t"}{.configMap}{"\t"}{.secret}{"\t"}{.projected}{"\n"}{end}'
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{range .volumeMounts[*]}{"  "}{.name}{"\t"}{.mountPath}{"\t"}{.subPath}{"\n"}{end}{end}'
```

Sort what you find into the four rules above:

- `configMapKeyRef`, `secretKeyRef`, `configMapRef` or `secretRef`: environment variables, so a restart is required.
- A `configMap`, `secret` or `projected` volume mounted without `subPath`: updates eventually.
- The same volume mounted with a `subPath` value: never updates.

Check whether the object itself is immutable:

```
kubectl --context CONTEXT_NAME get configmap CONFIGMAP_NAME -n NAMESPACE -o jsonpath='{.immutable}{"\n"}'
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.immutable}{"\n"}'
```

`true` means the object cannot have been changed in place, so if the value looks new, check that you are reading the object the pod references.

## Step 3: Compare what the container sees

Look at the value from inside the running container. For environment variables:

```
kubectl --context CONTEXT_NAME exec POD_NAME -n NAMESPACE -c CONTAINER_NAME -- env
```

For a mounted file:

```
kubectl --context CONTEXT_NAME exec POD_NAME -n NAMESPACE -c CONTAINER_NAME -- cat MOUNT_PATH
```

Be careful running either against Secrets in a shared terminal, since both print values in plain text. If exec fails, the [kubectl exec and port-forward guide](/blog/kubernetes-kubectl-exec-port-forward-errors) covers the common errors.

If the file inside the container already shows the new value but the application still behaves the old way, the application read it at startup. That is a restart, or a reload mechanism inside the application, not a Kubernetes problem.

## Step 4: Get the new value into the pods

Pick the fix that matches what Step 2 found.

**Environment variables.** Restart the workload so new pods start with the current values:

```
kubectl --context CONTEXT_NAME rollout restart deployment/DEPLOYMENT_NAME -n NAMESPACE
```

`kubectl rollout restart` also works for DaemonSets and StatefulSets. A Deployment's rollout is triggered only when its pod template changes, which is why editing a ConfigMap alone never replaces pods.

**Mounted volumes.** Wait. The documented delay is the kubelet sync period plus the cache propagation delay, which depends on how the cluster's kubelets are configured. The ConfigMap task page notes that you can trigger an immediate refresh by updating one of the pod's annotations. If you would rather not wait or touch individual pods, a rollout restart also works.

**subPath mounts.** The mount will never update, so restart the workload after every change. If the application needs live updates, mount the whole volume at a directory instead of a single file with `subPath`.

**Immutable objects.** You cannot edit the data. Delete and recreate the object, or create a new one under a new name and point the pod template at it. The docs recommend recreating existing pods after replacing an immutable object, because they keep a mount point to the deleted one.

Make the change through whatever owns the object, such as your manifests, Helm chart or Kustomize configuration, so the next deploy does not put the old value back.

## Step 5: Verify

Watch the restarted workload come up:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
```

Then repeat Step 3 against one of the new pods and confirm the value. If the rollout never finishes, the [stuck rollout guide](/blog/kubernetes-deployment-rollout-stuck) covers the Deployment side. If the new pods start and then exit because the new configuration is wrong for the application, follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff).

## Conclusion

When a pod ignores an updated ConfigMap or Secret, check how it consumes it. Environment variables are only read at container start, so restart the workload. Mounted volumes update on their own after a delay, `subPath` mounts never do, and immutable objects have to be replaced. If the file changed and the application did not, the application only read it at startup.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Configure a pod to use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [Distribute credentials securely using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [Declarative management of Kubernetes objects using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [kubectl rollout restart](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_restart/)

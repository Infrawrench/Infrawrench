---
title: "Kubernetes NetworkPolicy blocking traffic: find and fix the rule"
description: "Debug traffic blocked by Kubernetes NetworkPolicy: find which policies select a pod, read ingress and egress rules, fix the namespaceSelector and podSelector YAML gotcha, allow DNS and test with a temporary pod."
date: "2026-11-01"
kind: guide
---

A NetworkPolicy problem usually shows up as a timeout. Nothing is refused and nothing is logged: a request that worked yesterday now hangs, often right after someone added a "default deny" policy or relabelled a namespace. NetworkPolicy has no deny rules and no built-in logging, so the only way to find the cause is to work out which policies apply to the pods on each end and what they allow. This guide shows how the model works, how to find the policies that select a pod, how to read them, and how to fix the mistakes that block traffic most often.

Prerequisites: kubectl installed, access to the cluster, and permission to read NetworkPolicies, pods and namespaces, and to run a temporary pod. Everything here follows the official [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/) documentation. Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POLICY_NAME, POD_NAME, SERVICE_NAME, PORT and KEY=VALUE for a label. Replace them before running a command. If you have not yet confirmed that the Service itself is healthy, start with the [Service troubleshooting guide](/blog/kubernetes-service-no-endpoints), because a Service with no endpoints also looks like a timeout.

## How NetworkPolicy decides

Four rules explain almost every blocked connection:

- **Pods are open until a policy selects them.** With no policies, all ingress and egress traffic is allowed. A pod becomes isolated for ingress once any policy that selects it has `Ingress` in its `policyTypes`, and isolated for egress once any policy that selects it has `Egress`.
- **Policies only allow.** There is no deny rule. Once a pod is isolated in a direction, the only connections allowed are those some applicable policy lists. The rules from every policy that applies are added together, so the order of policies does not matter.
- **Both ends must agree.** For a connection between two pods, the source pod's egress policies and the destination pod's ingress policies must both allow it. If either side does not, the connection does not happen. Reply traffic for an allowed connection is allowed automatically.
- **The network plugin enforces it.** Creating a NetworkPolicy without a network plugin that supports NetworkPolicy has no effect.

Two exceptions are worth knowing: a pod cannot block traffic to itself, and traffic between a pod and the node it runs on is always allowed.

## Step 1: Confirm the traffic is actually blocked

Reproduce the failure from a temporary pod in the client's namespace, with the same labels as the real client, because policies match on labels:

```
kubectl --context CONTEXT_NAME run nptest --rm -ti --restart=Never --image=busybox -n NAMESPACE --labels="KEY=VALUE" -- /bin/sh
```

Inside the shell, test the Service with a short timeout:

```
wget --spider --timeout=1 SERVICE_NAME:PORT
```

`remote file exists` means the connection works. `download timed out` is the typical sign of a policy dropping traffic. A connection refused, or a name that does not resolve, points elsewhere: for DNS failures, see Step 6 and the [Kubernetes DNS troubleshooting guide](/blog/kubernetes-dns-troubleshooting).

Keep in mind that policies only cover TCP, UDP and SCTP. What happens to ICMP is up to the network plugin, so a failing `ping` proves nothing either way. Test with the real protocol and port.

## Step 2: Check that policies are enforced at all

List every policy in the cluster:

```
kubectl --context CONTEXT_NAME get networkpolicy --all-namespaces
```

If there are none, NetworkPolicy is not your problem. If there are some but traffic you expected to be blocked still flows, check that your network plugin supports NetworkPolicy. On a plugin without support, policies are accepted by the API server and silently ignored.

## Step 3: Find the policies that select each pod

A policy's `podSelector` picks the pods in its own namespace that it applies to. An empty `podSelector` selects every pod in the namespace, which is how default deny policies work. List the policies in the destination pod's namespace with their selectors:

```
kubectl --context CONTEXT_NAME get networkpolicy -n NAMESPACE
```

The POD-SELECTOR column shows each selector, and `<none>` means every pod. Compare those selectors with the pod's labels:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE --show-labels
```

Every policy whose selector matches those labels applies to the pod. Do the same for the client pod's namespace if it has policies with `Egress` in their `policyTypes`. If the client and the server sit in different namespaces, you will often find a default deny on one side that nobody remembered.

## Step 4: Read each policy the way Kubernetes does

Describe each policy that applies:

```
kubectl --context CONTEXT_NAME describe networkpolicy POLICY_NAME -n NAMESPACE
```

The output lists the pod selector, the allowed ingress and egress rules and the policy types. The official documentation recommends `kubectl describe` precisely because it shows how Kubernetes interpreted the YAML, which is not always what the author meant.

Check `policyTypes` carefully. If it is not set, `Ingress` is always included, and `Egress` is included only if the policy has egress rules. So a policy written with only egress rules and no `policyTypes` also isolates its pods for ingress, and blocks inbound traffic its author never thought about.

Within a rule, traffic must match both the `from` (or `to`) peers and the `ports`. A rule that allows the right pods on port 8080 does nothing for a client that connects on 80.

## Step 5: The namespaceSelector and podSelector gotcha

This is the most common reason a policy allows the wrong thing. These two snippets look almost identical:

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
        podSelector:
          matchLabels:
            role: client
```

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
      - podSelector:
          matchLabels:
            role: client
```

The first has one `from` element with both selectors, so it allows pods labelled `role=client` in namespaces labelled `user=alice`. The second has two elements, an extra dash, so it allows pods labelled `role=client` in the policy's own namespace, or any pod in any namespace labelled `user=alice`. The first is narrow, the second is much broader. `kubectl describe` shows the difference, so trust its output over your reading of the YAML.

Two more selector details catch people out:

- **podSelector alone means the same namespace.** In a `from` or `to` entry, a `podSelector` without a `namespaceSelector` only matches pods in the policy's namespace. A client in another namespace needs a `namespaceSelector`.
- **Namespaces are selected by label, not name.** There is no field for a namespace name. Use the label the control plane sets on every namespace, `kubernetes.io/metadata.name`, whose value is the namespace name. Check a namespace's labels with `kubectl --context CONTEXT_NAME get namespace NAMESPACE --show-labels`.

## Step 6: Egress policies and DNS

When a pod is isolated for egress, everything it sends must be allowed, including its DNS queries. A default deny egress policy therefore breaks name resolution, and the application reports "could not resolve host" rather than a timeout. The official documentation calls this out: if workloads need DNS, add a policy that allows egress to the cluster DNS Service.

A policy that allows every pod in a namespace to reach CoreDNS, which carries the `k8s-app=kube-dns` label in `kube-system`, looks like this:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: NAMESPACE
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

Note that it uses the single-element form from Step 5, so it only allows the DNS pods, not everything in `kube-system`. Check the labels on your DNS pods before you apply it, since some clusters use a different DNS add-on.

## Step 7: ipBlock, hostNetwork and timing

A few behaviours depend on the network plugin rather than on Kubernetes:

- **ipBlock is for addresses outside the cluster.** Pod IPs change, so use selectors for pods. Load balancers and Service routing can also rewrite source or destination IPs, and whether that happens before or after policy is checked varies by plugin and cloud provider. An `ipBlock` that allows a client's real IP may never see it, because the policy sees the IP of a load balancer or node instead.
- **hostNetwork pods are usually invisible to selectors.** Behaviour is undefined, but most plugins treat traffic from a `hostNetwork` pod as traffic from its node's IP. Selectors will not match such a pod, though an `ipBlock` for the node's address can.
- **New policies and pods take a moment.** A plugin may take some time to apply a new policy, and a new pod can briefly have less connectivity than expected. If something fails only right after startup, an init container that waits for its dependencies is the documented fix.
- **Existing connections.** Whether a policy change affects connections that are already open is up to the plugin. Restart the client before you conclude a fix did not work.

## Step 8: Fix and verify

Fix the policy rather than deleting it: add the missing peer or port to an allow rule, add a policy for the missing direction, or correct the selector. Because policies are additive, a new, narrow allow policy is often the safest change. Apply it, then rerun the test from Step 1 with the client's labels:

```
kubectl --context CONTEXT_NAME run nptest --rm -ti --restart=Never --image=busybox -n NAMESPACE --labels="KEY=VALUE" -- /bin/sh
wget --spider --timeout=1 SERVICE_NAME:PORT
```

Also run it once without the labels, or from another namespace, to confirm traffic that should stay blocked still is. If the Service now answers inside the cluster but requests through an Ingress fail, the problem is in front of the Service: follow the [Kubernetes Ingress troubleshooting guide](/blog/kubernetes-ingress-502-503).

## Conclusion

When traffic stops, list the policies that select the pods on both ends, read them with `kubectl describe`, and check the direction, the ports and the selector structure. Most NetworkPolicy outages come down to a default deny with a missing allow, a dash in the wrong place in a `from` list, or an egress policy that forgot DNS.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Declare Network Policy](https://kubernetes.io/docs/tasks/administer-cluster/declare-network-policy/)
- [Network plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- [Debugging DNS resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)

---
title: "Kubernetes Ingress returning 502, 503 or 404: a troubleshooting guide"
description: "Fix a Kubernetes Ingress that returns errors or never gets an address by checking the Ingress controller, ingressClassName, rules and pathType, the backend Service and port, endpoints and TLS secrets in order."
date: "2026-11-01"
kind: guide
---

An Ingress that returns an error page is rarely broken in one obvious place. The request passes through an Ingress controller, an IngressClass, a host and path rule, a Service and its port, and finally the pods behind that Service. Any one of those can be wrong while the rest look healthy. This guide walks the chain in order, using only what the official Kubernetes documentation says about each link.

Prerequisites: kubectl installed, access to the cluster, and permission to read Ingresses, IngressClasses, Services, EndpointSlices, Secrets and pods. Placeholders used throughout: CONTEXT_NAME, NAMESPACE, INGRESS_NAME, SERVICE_NAME, SECRET_NAME and HOST. Replace them before running a command.

## What the status code tells you, and what it does not

The Ingress resource only describes routing. The Ingress controller is what actually answers the request, so the exact status code and error page depend on which controller you run. As a rough guide, a request that matches no rule goes to a default backend, and a request that matches a rule whose backend has nothing to send traffic to fails at the controller. Check your controller's documentation for what each code means there, then use the steps below to find which link is broken.

## Step 1: Is there an Ingress controller?

The official documentation is blunt about this: you must have an Ingress controller to satisfy an Ingress, and creating an Ingress resource on its own has no effect. You need to select at least one Ingress controller and make sure it is set up in your cluster.

```
kubectl --context CONTEXT_NAME get ingress INGRESS_NAME -n NAMESPACE
```

Look at the ADDRESS column. Controllers and load balancers may take a minute or two to allocate an address, and until then you often see it as empty or `<pending>`. If it stays empty, either no controller is running or no controller has picked up this Ingress. Find the controller's pods (where they live depends on how it was installed) and read their logs.

## Step 2: Is the Ingress assigned to the right class?

A cluster can run several Ingress controllers. Each Ingress should name the one that serves it with `spec.ingressClassName`, which refers to an IngressClass resource. List the classes and check what the Ingress asks for:

```
kubectl --context CONTEXT_NAME get ingressclass
kubectl --context CONTEXT_NAME get ingress INGRESS_NAME -n NAMESPACE -o jsonpath='{.spec.ingressClassName}{"\n"}'
```

The name must match the `metadata.name` of an IngressClass that your controller handles. If the field is empty, Kubernetes applies the default IngressClass, but only when exactly one IngressClass carries the `ingressclass.kubernetes.io/is-default-class` annotation set to `"true"`. If more than one class is marked default, the admission controller refuses new Ingresses that have no `ingressClassName`. If none is marked default, the documentation says one should be defined, although some controllers work without it.

Older manifests use the `kubernetes.io/ingress.class` annotation instead. The `ingressClassName` field replaces it, but the two are not direct equivalents: the annotation usually named a controller, while the field points at an IngressClass resource.

## Step 3: Read the Ingress the way the controller does

`kubectl describe` shows the rules, the backend each path resolves to and the pod addresses behind each backend:

```
kubectl --context CONTEXT_NAME describe ingress INGRESS_NAME -n NAMESPACE
```

In the official example, each backend is listed as `service1:4200 (10.8.0.90:4200)`. The part in brackets is the endpoint the controller can send traffic to. If a backend shows no addresses, or an error in place of them, jump to Step 6. Check the Events section at the bottom too: in the official example, that is where the controller's own events appear.

## Step 4: Does the request match a rule?

Both the host and the path must match before a request reaches a rule's backend. A request that matches no rule goes to the default backend, which is usually configured in the controller rather than in your Ingress. So a host or path that does not match gets whatever the default backend returns, often an error page from the controller, not a response from your app.

**Host.** A rule with a host only applies when the request's `Host` header matches it. A wildcard such as `*.foo.com` covers exactly one DNS label: it matches `bar.foo.com`, but not `baz.bar.foo.com` and not `foo.com`. If you test with curl against an IP address, send the header yourself:

```
curl -v -H "Host: HOST" http://INGRESS_ADDRESS/path
```

**Path type.** Every path needs a `pathType`, and a path without one fails validation. The three types behave differently:

- `Exact` matches the URL path exactly, case-sensitively. `/foo` does not match `/foo/`.
- `Prefix` matches element by element, split on `/`. `/aaa/bbb` matches `/aaa/bbb`, `/aaa/bbb/` and `/aaa/bbb/ccc`, but not `/aaa/bbbxyz`.
- `ImplementationSpecific` leaves matching to the IngressClass, so check your controller's documentation.

When several paths match, the longest one wins, and on a tie `Exact` beats `Prefix`. A broad `/` rule pointing at the wrong Service can quietly catch requests you meant for another backend.

Controllers also read annotations for behaviour such as path rewriting. Which annotations they support is controller-specific, so confirm any annotation on the Ingress against your controller's documentation.

## Step 5: Does the backend Service exist, with the right port?

Each path's backend names a Service and a port, either by `service.port.number` or `service.port.name`. The Service must exist in the same namespace as the Ingress: an Ingress cannot point at a Service in another namespace.

```
kubectl --context CONTEXT_NAME get service SERVICE_NAME -n NAMESPACE -o yaml
```

Check that:

- **The Service exists** in the Ingress's namespace, under exactly the name the rule uses.
- **The port matches.** A numeric backend port must be one of the Service's `spec.ports[].port` values, not the pod's `targetPort`. A named backend port must match a port `name` on the Service.

Keep in mind that Ingress only routes HTTP and HTTPS. Other protocols need a Service of type NodePort or LoadBalancer.

## Step 6: Does the Service have ready endpoints?

A frequent reason for a 502 or 503 is that the Ingress routes correctly, but the Service has nothing ready to send traffic to.

```
kubectl --context CONTEXT_NAME get endpointslices -n NAMESPACE -l kubernetes.io/service-name=SERVICE_NAME
```

If there are no endpoints, the Service's selector matches no pods, or the pods that match are not ready. The [Kubernetes Service troubleshooting guide](/blog/kubernetes-service-no-endpoints) walks through selectors, ports and endpoint conditions step by step. If pods exist but are not ready, the [readiness probe guide](/blog/kubernetes-readiness-probe-failed) covers why.

Before blaming the Ingress, test the Service from inside the cluster. If a temporary pod cannot reach `SERVICE_NAME:PORT`, the problem is behind the Ingress and fixing the Ingress will not help.

## Step 7: Is TLS configured correctly?

If HTTP works and HTTPS fails, or the browser shows the wrong certificate, check the `tls` section:

```
kubectl --context CONTEXT_NAME get ingress INGRESS_NAME -n NAMESPACE -o jsonpath='{.spec.tls}{"\n"}'
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.type}{"\n"}'
```

The official requirements:

- **The Secret must contain `tls.crt` and `tls.key`**, and the documented example uses type `kubernetes.io/tls`.
- **The certificate must cover the host.** It must come from a certificate whose Common Name (the fully qualified domain name) matches the host you serve.
- **`hosts` in the `tls` section must match a `host` in the rules.** TLS does not work on the default rule with no host, because the certificate would have to cover every possible subdomain.
- **Ingress supports a single TLS port, 443**, and terminates TLS at the ingress point.

TLS support differs between controllers, so check your controller's documentation for anything beyond these basics.

## Step 8: Fix and verify

Apply the fix where it belongs: install or repair the controller, set `ingressClassName` or the default class, correct the host, path or `pathType`, fix the backend Service name or port, make the pods ready, or replace the TLS Secret. Then check the chain again:

```
kubectl --context CONTEXT_NAME get ingress INGRESS_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME describe ingress INGRESS_NAME -n NAMESPACE
curl -v -H "Host: HOST" http://INGRESS_ADDRESS/path
```

The Ingress should have an address, every backend should list pod addresses, and the request should reach your app.

One more thing worth knowing: the Kubernetes project now recommends Gateway API over Ingress. The Ingress API is frozen. It is still generally available and there are no plans to remove it, but it will not get new features. If you are designing new routing, consider Gateway.

## Conclusion

An Ingress error is a chain with one broken link. Check, in order: a controller is running and has given the Ingress an address, the Ingress names a class that controller serves, the request's host and path match a rule, the backend Service exists in the same namespace with the right port, that Service has ready endpoints, and TLS is set up with a matching Secret. Stop at the first check that fails and fix that.

If you jump between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Ingress controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [Ingress API reference](https://kubernetes.io/docs/reference/kubernetes-api/service-resources/ingress-v1/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)

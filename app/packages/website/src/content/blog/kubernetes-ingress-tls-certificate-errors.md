---
title: "Kubernetes Ingress TLS certificate errors: how to fix them"
description: "Fix a Kubernetes Ingress that serves the wrong certificate, a self-signed default or no HTTPS at all by checking the tls hosts, the Secret's namespace, type and keys, and the certificate itself in order."
date: "2026-11-05"
kind: guide
---

You add a `tls` section to an Ingress, open the site over HTTPS, and the browser warns that the certificate is not trusted, or names a different host, or the connection fails outright. The Ingress object looks fine and kubectl reports no error. Almost every case comes down to the Ingress controller not finding a certificate it can use for that host, so it falls back to something else. This guide works through the causes in order, from the Ingress spec to the certificate file itself.

Prerequisites: kubectl installed, access to the cluster, permission to read Ingresses, Secrets and events in the namespace, and `openssl` on your machine. Everything here follows the official [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/#tls) and [Secret](https://kubernetes.io/docs/concepts/configuration/secret/#tls-secrets) documentation. Placeholders used throughout: CONTEXT_NAME, NAMESPACE, INGRESS_NAME, SECRET_NAME and HOST. Replace them before running a command. If the problem is a 502, 503 or 404 rather than a certificate warning, the [Ingress errors guide](/blog/kubernetes-ingress-502-503) is the better starting point.

## How an Ingress gets its certificate

The official documentation describes the moving parts:

1. **You store the certificate and private key in a Secret** with keys named `tls.crt` and `tls.key`, usually of type `kubernetes.io/tls`.
2. **The Ingress lists that Secret under `spec.tls`**, together with the hosts it covers.
3. **The Ingress controller reads both** and terminates TLS on port 443. The Ingress resource only supports that single TLS port, and traffic from the controller to your Service and pods is plain HTTP.
4. **When several hosts share port 443**, the controller picks the certificate by the hostname the client sends through SNI, if the controller supports SNI.

When any of these links is broken, most controllers keep serving HTTPS with a certificate of their own, which is why the symptom is a browser warning rather than a clear error in Kubernetes.

## Step 1: See which certificate is actually served

Before changing anything, find out what the client gets. This connects with SNI for your host and prints the subject, issuer, names and validity of the certificate that comes back:

```
openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName -dates
```

The answer tells you where to look:

- **A certificate issued by your controller itself, or self-signed**, usually means the controller could not use your Secret for this host. Go to Step 2.
- **Your certificate, but for other names**, means the wrong Secret is matched, or the certificate does not cover HOST. Go to Steps 2 and 4.
- **Your certificate with an expired `notAfter` date** means the Secret still holds the old certificate. Go to Step 5.
- **No certificate at all, or a connection error**, means nothing is serving TLS for this address. Check that HOST resolves to the controller's address and that the controller listens on 443.

## Step 2: Do the tls hosts match the rules?

The official documentation has a note that catches many people: TLS will not work on the default rule, because the certificate would have to be issued for every possible subdomain. Hosts in the `tls` section need to explicitly match the host in the `rules` section.

```
kubectl --context CONTEXT_NAME get ingress INGRESS_NAME -n NAMESPACE -o jsonpath='{range .spec.tls[*]}{.hosts}{" -> "}{.secretName}{"\n"}{end}{range .spec.rules[*]}rule: {.host}{"\n"}{end}'
```

Check that:

- **Every host you browse to appears under both `tls[].hosts` and `rules[].host`**, spelled exactly the same.
- **A rule without a host** is not covered by any certificate. Give it a host, or accept that HTTPS on it falls back to the controller's default.
- **`secretName` is set** for the hosts that need it, and points at the Secret you expect.

## Step 3: Is the Secret where the Ingress can use it?

`secretName` takes only a name, with no namespace field, so the controller looks for the Secret in the Ingress's own namespace. A Secret created in `default` while the Ingress lives in `NAMESPACE` is invisible to it.

```
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.type}{"\n"}{range .data}{"key present\n"}{end}'
kubectl --context CONTEXT_NAME describe secret SECRET_NAME -n NAMESPACE
```

`describe` lists the keys and their sizes without printing the values. Look for:

- **The Secret exists in the Ingress's namespace.** If `NotFound`, create it there.
- **The keys are named `tls.crt` and `tls.key`.** The Ingress documentation requires exactly those names. A Secret created from files called `cert.pem` and `key.pem` with `--from-file` keeps those file names as keys, and the controller will not find the certificate.
- **The type is `kubernetes.io/tls`.** The Secret documentation notes that the API server checks the required keys exist for this type, but does not validate the values, so a Secret can be accepted and still hold the wrong data.

The simplest way to get all three right is the dedicated subcommand, which also requires that the certificate matches the key:

```
kubectl --context CONTEXT_NAME create secret tls SECRET_NAME -n NAMESPACE --cert=path/to/tls.crt --key=path/to/tls.key
```

Then read the controller's view. Many controllers record a warning event on the Ingress when a referenced Secret is missing or unusable:

```
kubectl --context CONTEXT_NAME describe ingress INGRESS_NAME -n NAMESPACE
```

## Step 4: Is the certificate right for the host?

The Secret can be perfectly formed and still hold the wrong certificate. Decode it and inspect it:

```
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -issuer -ext subjectAltName -dates
```

Check that:

- **HOST is among the names.** The official documentation asks for a certificate whose name matches the host in the Ingress. Modern clients check the subject alternative names, so the host should appear there. A wildcard such as `*.example.com` covers `app.example.com` but not `example.com` or `a.b.example.com`.
- **The dates are current.** An expired or not-yet-valid certificate fails in every client.
- **The private key belongs to the certificate.** These two commands should print the same value:

```
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -pubkey | openssl sha256
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.data.tls\.key}' | base64 -d | openssl pkey -pubout | openssl sha256
```

- **The chain is complete.** If browsers accept the site but some clients, such as curl or mobile apps, report an unknown issuer, `tls.crt` probably holds only the leaf certificate. Put the leaf first and the intermediate certificates after it in the same file, then recreate the Secret.

## Step 5: You renewed the certificate but the old one is still served

Renewing a certificate on disk changes nothing in the cluster until the Secret holds the new one. Recreate or update the Secret in place:

```
kubectl --context CONTEXT_NAME create secret tls SECRET_NAME -n NAMESPACE --cert=path/to/tls.crt --key=path/to/tls.key --dry-run=client -o yaml | kubectl --context CONTEXT_NAME apply -f -
```

Run Step 4 against the Secret to confirm it now holds the new dates, then Step 1 against the live host. If the Secret is new but the old certificate is still served, the controller has not reloaded it yet; check its logs for errors about the Secret. If the Secret is managed by a certificate tool, the renewal problem is in that tool, not the Ingress: check its own resources and logs.

## Step 6: Different controllers, different TLS behaviour

The Ingress documentation warns that TLS features vary between controllers. Redirecting HTTP to HTTPS, choosing a default certificate, TLS passthrough to the pod, minimum TLS versions and client certificate authentication are all controller options, usually set with annotations or the controller's own configuration rather than the Ingress spec. If a setting has no effect, compare it with the documentation for the controller named in `spec.ingressClassName`:

```
kubectl --context CONTEXT_NAME get ingress INGRESS_NAME -n NAMESPACE -o jsonpath='{.spec.ingressClassName}{"\n"}'
kubectl --context CONTEXT_NAME get ingressclass
```

An Ingress whose class no controller handles is not served at all, with or without TLS.

## Conclusion

An Ingress serving the wrong certificate is usually a controller that could not use yours. Check, in order: what the client actually receives, that the `tls` hosts match the rule hosts, that the Secret sits in the Ingress's namespace with `tls.crt` and `tls.key`, and that the certificate covers the host, is in date, matches its key and carries its chain. After any change, confirm with the same `openssl s_client` command you started with.

If you chase certificates across several clusters and cloud accounts, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Ingress: TLS](https://kubernetes.io/docs/concepts/services-networking/ingress/#tls)
- [Secrets: TLS Secrets](https://kubernetes.io/docs/concepts/configuration/secret/#tls-secrets)
- [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [kubectl create secret tls](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_secret_tls/)

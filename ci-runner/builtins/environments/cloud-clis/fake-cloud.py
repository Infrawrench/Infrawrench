"""A small fake of the cloud APIs builtins/test.sh runs the Python tools
against, on a job's own loopback: never a real provider.

Only the calls the tests make, answered the way the real services answer
them (shapes from each API's reference), and every request checked against
the credentials the test lends, so a CLI that did not pick up a lent
credential fails:

  AWS     (http, port 4566): STS GetCallerIdentity; S3 ListBuckets,
          ListObjectsV2, PutObject, GetObject, HeadObject; ECR
          GetAuthorizationToken; CloudFormation DescribeStacks,
          CreateChangeSet, DescribeChangeSet, ExecuteChangeSet,
          DescribeStackEvents; Lambda UpdateFunctionCode; EKS DescribeCluster.
          Requests must carry the lent session (FAKE_AWS_KEY and
          FAKE_AWS_TOKEN); the signature itself is not checked.
  Google  (http, port 4566, under /gcp/): Resource Manager projects.get and
          Cloud Storage objects.list. A bearer token equal to FAKE_GCP_TOKEN.
  Azure   (https, port 4567, with --cert and --key): Entra ID's discovery
          documents and client-credentials token endpoint (the client
          secret must be FAKE_AZURE_SECRET), and Resource Manager's tenants,
          subscriptions and resource groups, for the token it issued.

Standard library only. Run as `python fake-cloud.py [--cert c --key k]`.
"""

import base64
import hashlib
import http.server
import io
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from xml.sax.saxutils import escape

AWS_KEY = os.environ.get("FAKE_AWS_KEY", "")
AWS_TOKEN = os.environ.get("FAKE_AWS_TOKEN", "")
GCP_TOKEN = os.environ.get("FAKE_GCP_TOKEN", "")
AZURE_SECRET = os.environ.get("FAKE_AZURE_SECRET", "")
ACCOUNT = "123456789012"
AZURE_ISSUED = "fake-azure-access-token"

# What the fake holds: S3 objects by bucket and key, CloudFormation stacks
# and change sets, Lambda functions' code hashes.
s3 = {"assets": {}}
stacks = {}
change_sets = {}
functions = {"web": None}
lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def aws_xml(action, inner, ns):
    return (
        f'<{action}Response xmlns="{ns}"><{action}Result>{inner}</{action}Result>'
        f"<ResponseMetadata><RequestId>fake</RequestId></ResponseMetadata></{action}Response>"
    )


def aws_error(code, message, status=400, query=True):
    if query:
        body = (
            "<ErrorResponse><Error><Type>Sender</Type>"
            f"<Code>{code}</Code><Message>{escape(message)}</Message></Error>"
            "<RequestId>fake</RequestId></ErrorResponse>"
        )
    else:
        body = f"<Error><Code>{code}</Code><Message>{escape(message)}</Message></Error>"
    return status, "text/xml", body.encode()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("fake-cloud: " + fmt % args + "\n")

    # One entry point for every method.
    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_HEAD(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def body(self):
        if getattr(self, "_body", None) is None:
            length = int(self.headers.get("Content-Length") or 0)
            self._body = self.rfile.read(length) if length else b""
        return self._body

    def send(self, status, ctype, data, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def route(self):
        self._body = None
        # Read before answering, so an answer before the body (a refusal)
        # leaves nothing of it on a kept-alive connection.
        self.body()
        url = urllib.parse.urlsplit(self.path)
        try:
            if url.path.startswith("/gcp/"):
                result = self.gcp(url)
            elif self.server.server_port == 4567:
                result = self.azure(url)
            else:
                result = self.aws(url)
        except Exception as err:  # a bug in the fake, said plainly
            result = (500, "text/plain", f"fake-cloud: {err!r}".encode())
        status, ctype, data, *rest = result
        self.send(status, ctype, data, rest[0] if rest else None)

    # ---------------------------------------------------------------- AWS

    def aws(self, url):
        auth = self.headers.get("Authorization", "")
        m = re.search(r"Credential=([^/]+)/\d{8}/([^/]+)/([^/]+)/aws4_request", auth)
        if not m:
            return aws_error("MissingAuthenticationToken", "Request is missing Authentication Token", 403)
        key, _region, service = m.groups()
        if key != AWS_KEY or self.headers.get("X-Amz-Security-Token") != AWS_TOKEN:
            return aws_error(
                "InvalidClientTokenId", "The security token included in the request is invalid.", 403
            )
        if service == "s3":
            return self.s3(url)
        if service == "lambda":
            return self.aws_lambda(url)
        if service == "eks":
            return self.eks(url)
        target = self.headers.get("X-Amz-Target", "")
        if target.startswith("AmazonEC2ContainerRegistry"):
            return self.ecr(target)
        form = dict(urllib.parse.parse_qsl(self.body().decode()))
        action = form.get("Action", "")
        if service == "sts" and action == "GetCallerIdentity":
            inner = (
                f"<Arn>arn:aws:iam::{ACCOUNT}:user/ci</Arn><UserId>AIDAFAKE</UserId>"
                f"<Account>{ACCOUNT}</Account>"
            )
            return 200, "text/xml", aws_xml(action, inner, "https://sts.amazonaws.com/doc/2011-06-15/").encode()
        if service == "cloudformation":
            return self.cloudformation(action, form)
        return aws_error("InvalidAction", f"{service} {action} is not in the fake")

    def s3(self, url):
        parts = url.path.lstrip("/").split("/", 1)
        query = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
        ns = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
        if parts == [""]:
            buckets = "".join(
                f"<Bucket><Name>{b}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>"
                for b in s3
            )
            body = f"<ListAllMyBucketsResult {ns}><Owner><ID>fake</ID></Owner><Buckets>{buckets}</Buckets></ListAllMyBucketsResult>"
            return 200, "application/xml", body.encode()
        bucket = parts[0]
        key = urllib.parse.unquote(parts[1]) if len(parts) > 1 else ""
        if bucket not in s3:
            return aws_error("NoSuchBucket", "The specified bucket does not exist", 404, query=False)
        objects = s3[bucket]
        if not key and self.command == "GET":
            prefix = query.get("prefix", "")
            with lock:
                keys = sorted(k for k in objects if k.startswith(prefix))
            contents = "".join(
                f"<Contents><Key>{escape(k)}</Key><LastModified>{objects[k][1]}</LastModified>"
                f'<ETag>"{hashlib.md5(objects[k][0]).hexdigest()}"</ETag><Size>{len(objects[k][0])}</Size>'
                "<StorageClass>STANDARD</StorageClass></Contents>"
                for k in keys
            )
            body = (
                f"<ListBucketResult {ns}><Name>{bucket}</Name><Prefix>{escape(prefix)}</Prefix>"
                f"<KeyCount>{len(keys)}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>"
                f"{contents}</ListBucketResult>"
            )
            return 200, "application/xml", body.encode()
        if self.command == "PUT":
            data = self.body()
            if self.headers.get("Content-Encoding", "") == "aws-chunked" or "STREAMING" in self.headers.get(
                "x-amz-content-sha256", ""
            ):
                data = decode_chunked(data)
            with lock:
                objects[key] = (data, now_iso())
            return 200, "application/xml", b"", {"ETag": f'"{hashlib.md5(data).hexdigest()}"'}
        if self.command in ("GET", "HEAD"):
            with lock:
                found = objects.get(key)
            if not found:
                return aws_error("NoSuchKey", "The specified key does not exist.", 404, query=False)
            data, modified = found
            stamp = datetime.strptime(modified, "%Y-%m-%dT%H:%M:%S.000Z").strftime("%a, %d %b %Y %H:%M:%S GMT")
            headers = {"ETag": f'"{hashlib.md5(data).hexdigest()}"', "Last-Modified": stamp}
            return 200, "application/octet-stream", data, headers
        if self.command == "DELETE":
            with lock:
                objects.pop(key, None)
            return 204, "application/xml", b""
        return aws_error("NotImplemented", "not in the fake", 501, query=False)

    def ecr(self, target):
        if not target.endswith(".GetAuthorizationToken"):
            return 400, "application/x-amz-json-1.1", b'{"__type":"InvalidAction"}'
        token = base64.b64encode(b"AWS:fake-ecr-password").decode()
        body = {
            "authorizationData": [
                {
                    "authorizationToken": token,
                    "expiresAt": time.time() + 43200,
                    "proxyEndpoint": f"https://{ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com",
                }
            ]
        }
        return 200, "application/x-amz-json-1.1", json.dumps(body).encode()

    def cloudformation(self, action, form):
        ns = "http://cloudformation.amazonaws.com/doc/2010-05-15/"
        name = form.get("StackName", "")
        with lock:
            if action == "DescribeStacks":
                stack = stacks.get(name)
                if not stack:
                    return aws_error("ValidationError", f"Stack with id {name} does not exist")
                inner = (
                    f"<Stacks><member><StackName>{name}</StackName><StackId>{stack['id']}</StackId>"
                    f"<StackStatus>{stack['status']}</StackStatus><CreationTime>{stack['created']}</CreationTime>"
                    "</member></Stacks>"
                )
                return 200, "text/xml", aws_xml(action, inner, ns).encode()
            if action == "CreateChangeSet":
                template = form.get("TemplateBody", "")
                if "Resources" not in template:
                    return aws_error("ValidationError", "Template format error: missing Resources")
                stack_id = f"arn:aws:cloudformation:us-east-1:{ACCOUNT}:stack/{name}/1"
                cs_id = f"arn:aws:cloudformation:us-east-1:{ACCOUNT}:changeSet/{form.get('ChangeSetName')}/1"
                change_sets[cs_id] = {"stack": name, "stack_id": stack_id, "type": form.get("ChangeSetType")}
                stacks.setdefault(name, {"id": stack_id, "status": "REVIEW_IN_PROGRESS", "created": now_iso()})
                inner = f"<Id>{cs_id}</Id><StackId>{stack_id}</StackId>"
                return 200, "text/xml", aws_xml(action, inner, ns).encode()
            if action == "DescribeChangeSet":
                cs = change_sets.get(form.get("ChangeSetName", ""))
                if not cs:
                    return aws_error("ChangeSetNotFound", "ChangeSet does not exist", 404)
                inner = (
                    f"<ChangeSetId>{form['ChangeSetName']}</ChangeSetId><StackId>{cs['stack_id']}</StackId>"
                    f"<StackName>{cs['stack']}</StackName><Status>CREATE_COMPLETE</Status>"
                    "<ExecutionStatus>AVAILABLE</ExecutionStatus><Changes><member><Type>Resource</Type>"
                    "<ResourceChange><Action>Add</Action><LogicalResourceId>Queue</LogicalResourceId>"
                    "<ResourceType>AWS::SQS::Queue</ResourceType></ResourceChange></member></Changes>"
                )
                return 200, "text/xml", aws_xml(action, inner, ns).encode()
            if action == "ExecuteChangeSet":
                cs = change_sets.get(form.get("ChangeSetName", ""))
                if not cs:
                    return aws_error("ChangeSetNotFound", "ChangeSet does not exist", 404)
                stacks[cs["stack"]]["status"] = "CREATE_COMPLETE" if cs["type"] == "CREATE" else "UPDATE_COMPLETE"
                return 200, "text/xml", aws_xml(action, "", ns).encode()
            if action == "DescribeStackEvents":
                return 200, "text/xml", aws_xml(action, "<StackEvents/>", ns).encode()
        return aws_error("InvalidAction", f"cloudformation {action} is not in the fake")

    def aws_lambda(self, url):
        m = re.fullmatch(r"/2015-03-31/functions/([^/]+)/code", url.path)
        if not m or self.command != "PUT":
            return 404, "application/json", b'{"Type":"User","Message":"not in the fake"}'
        name = urllib.parse.unquote(m.group(1))
        if name not in functions:
            msg = f"Function not found: arn:aws:lambda:us-east-1:{ACCOUNT}:function:{name}"
            return 404, "application/json", json.dumps({"Type": "User", "Message": msg}).encode(), {
                "x-amzn-ErrorType": "ResourceNotFoundException"
            }
        zipped = base64.b64decode(json.loads(self.body() or b"{}").get("ZipFile", ""))
        digest = base64.b64encode(hashlib.sha256(zipped).digest()).decode()
        with lock:
            functions[name] = digest
        body = {
            "FunctionName": name,
            "FunctionArn": f"arn:aws:lambda:us-east-1:{ACCOUNT}:function:{name}",
            "Runtime": "python3.13",
            "CodeSha256": digest,
            "CodeSize": len(zipped),
            "LastModified": now_iso(),
            "State": "Active",
            "LastUpdateStatus": "Successful",
        }
        return 200, "application/json", json.dumps(body).encode()

    def eks(self, url):
        m = re.fullmatch(r"/clusters/([^/]+)", url.path)
        if not m:
            return 404, "application/json", b'{"message":"not in the fake"}'
        name = m.group(1)
        body = {
            "cluster": {
                "name": name,
                "arn": f"arn:aws:eks:us-east-1:{ACCOUNT}:cluster/{name}",
                "endpoint": "https://127.0.0.1:6443",
                "status": "ACTIVE",
                "version": "1.37",
                "certificateAuthority": {"data": base64.b64encode(b"fake-ca").decode()},
            }
        }
        return 200, "application/json", json.dumps(body).encode()

    # ------------------------------------------------------------- Google

    def gcp(self, url):
        if self.headers.get("Authorization", "") != f"Bearer {GCP_TOKEN}":
            body = {"error": {"code": 401, "message": "Request had invalid authentication credentials.", "status": "UNAUTHENTICATED"}}
            return 401, "application/json", json.dumps(body).encode()
        m = re.fullmatch(r"/gcp/(?:v1|v3)/projects/([^/:]+)", url.path)
        if m:
            project = m.group(1)
            body = {
                "projectNumber": "424242424242",
                "projectId": project,
                "name": f"projects/424242424242" if "/v3/" in url.path else project,
                "lifecycleState": "ACTIVE",
                "state": "ACTIVE",
            }
            return 200, "application/json", json.dumps(body).encode()
        m = re.fullmatch(r"/gcp/storage/v1/b/([^/]+)/o", url.path)
        if m:
            items = [{"kind": "storage#object", "name": "index.html", "bucket": m.group(1), "size": "12"}]
            return 200, "application/json", json.dumps({"kind": "storage#objects", "items": items}).encode()
        return 404, "application/json", json.dumps({"error": {"code": 404, "message": f"{url.path} is not in the fake"}}).encode()

    # -------------------------------------------------------------- Azure

    def azure(self, url):
        base = f"https://127.0.0.1:4567"
        m = re.fullmatch(r"/([^/]+)/v2\.0/\.well-known/openid-configuration", url.path)
        if m:
            tenant = m.group(1)
            body = {
                "token_endpoint": f"{base}/{tenant}/oauth2/v2.0/token",
                "authorization_endpoint": f"{base}/{tenant}/oauth2/v2.0/authorize",
                "issuer": f"{base}/{tenant}/v2.0",
                "device_authorization_endpoint": f"{base}/{tenant}/oauth2/v2.0/devicecode",
            }
            return 200, "application/json", json.dumps(body).encode()
        if url.path.lstrip("/") == "metadata/endpoints":
            # Resource Manager's description of its cloud, which
            # `az cloud register --endpoint-resource-manager` reads.
            body = {
                "name": "Fixture",
                "resourceManager": f"{base}/",
                "authentication": {
                    "loginEndpoint": base,
                    "audiences": ["https://management.core.windows.net/", "https://management.azure.com/"],
                    "tenant": "common",
                    "identityProvider": "AAD",
                },
                "graph": "https://graph.windows.net/",
                "graphAudience": "https://graph.windows.net/",
                "suffixes": {"storage": "core.windows.net", "keyVaultDns": "vault.azure.net"},
            }
            return 200, "application/json", json.dumps(body).encode()
        if url.path == "/common/discovery/instance":
            body = {"tenant_discovery_endpoint": f"{base}/common/v2.0/.well-known/openid-configuration", "metadata": []}
            return 200, "application/json", json.dumps(body).encode()
        m = re.fullmatch(r"/([^/]+)/oauth2/v2\.0/token", url.path)
        if m:
            form = dict(urllib.parse.parse_qsl(self.body().decode()))
            if form.get("client_secret") != AZURE_SECRET:
                body = {"error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret provided."}
                return 401, "application/json", json.dumps(body).encode()
            claims = {"tid": m.group(1), "appid": form.get("client_id"), "oid": "fake-oid", "exp": int(time.time()) + 3600}
            token = ".".join(
                base64.urlsafe_b64encode(json.dumps(part).encode()).decode().rstrip("=")
                for part in ({"alg": "none", "typ": "JWT"}, claims)
            ) + "." + AZURE_ISSUED
            body = {"token_type": "Bearer", "expires_in": 3599, "ext_expires_in": 3599, "access_token": token}
            return 200, "application/json", json.dumps(body).encode()
        if not self.headers.get("Authorization", "").endswith("." + AZURE_ISSUED):
            body = {"error": {"code": "AuthenticationFailed", "message": "Authentication failed."}}
            return 401, "application/json", json.dumps(body).encode()
        if url.path == "/tenants":
            body = {"value": [{"id": "/tenants/fake", "tenantId": TENANT, "displayName": "Fixture"}]}
            return 200, "application/json", json.dumps(body).encode()
        if url.path == "/subscriptions":
            body = {"value": [SUBSCRIPTION]}
            return 200, "application/json", json.dumps(body).encode()
        m = re.fullmatch(r"/subscriptions/([^/]+)/resourcegroups", url.path, re.I)
        if m:
            body = {
                "value": [
                    {
                        "id": f"/subscriptions/{m.group(1)}/resourceGroups/web",
                        "name": "web",
                        "location": "uksouth",
                        "type": "Microsoft.Resources/resourceGroups",
                        "properties": {"provisioningState": "Succeeded"},
                    }
                ]
            }
            return 200, "application/json", json.dumps(body).encode()
        m = re.fullmatch(r"/subscriptions/([^/]+)", url.path)
        if m:
            return 200, "application/json", json.dumps(SUBSCRIPTION).encode()
        return 404, "application/json", json.dumps({"error": {"code": "NotFound", "message": f"{url.path} is not in the fake"}}).encode()


TENANT = os.environ.get("FAKE_AZURE_TENANT", "00000000-0000-0000-0000-00000000000a")
SUB_ID = os.environ.get("FAKE_AZURE_SUBSCRIPTION", "00000000-0000-0000-0000-00000000000c")
SUBSCRIPTION = {
    "id": f"/subscriptions/{SUB_ID}",
    "subscriptionId": SUB_ID,
    "tenantId": TENANT,
    "displayName": "Fixture subscription",
    "state": "Enabled",
    "subscriptionPolicies": {"locationPlacementId": "Public_2014-09-01", "quotaId": "PayAsYouGo_2014-09-01", "spendingLimit": "Off"},
    "authorizationSource": "RoleBased",
}


def decode_chunked(data):
    """An `aws-chunked` body (`<hex size>;chunk-signature=...\\r\\n<data>\\r\\n...`), unwrapped."""
    out = b""
    while data:
        head, _, rest = data.partition(b"\r\n")
        size = int(head.split(b";", 1)[0], 16)
        if size == 0:
            break
        out += rest[:size]
        data = rest[size + 2 :]
    return out


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


class TLSStream(io.RawIOBase):
    """TLS over a connection through memory BIOs, for where `wrap_socket`
    cannot be used: it asks the socket for SO_TYPE first, which a job's
    sockets do not answer."""

    def __init__(self, sock, context):
        self.sock = sock
        self.incoming, self.outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        self.tls = context.wrap_bio(self.incoming, self.outgoing, server_side=True)
        self.call(self.tls.do_handshake)

    def flush_out(self):
        data = self.outgoing.read()
        if data:
            self.sock.sendall(data)

    def call(self, fn, *args):
        while True:
            try:
                result = fn(*args)
                self.flush_out()
                return result
            except ssl.SSLWantReadError:
                self.flush_out()
                chunk = self.sock.recv(65536)
                if chunk:
                    self.incoming.write(chunk)
                else:
                    self.incoming.write_eof()

    def readable(self):
        return True

    def readinto(self, buffer):
        try:
            data = self.call(self.tls.read, len(buffer))
        except (ssl.SSLZeroReturnError, ssl.SSLEOFError):
            data = b""
        buffer[: len(data)] = data
        return len(data)


class TLSConnection:
    """What a request handler needs of its connection, over TLSStream."""

    def __init__(self, sock, context):
        self.sock = sock
        self.stream = TLSStream(sock, context)

    def makefile(self, mode="rb", buffering=-1):
        return io.BufferedReader(self.stream)

    def sendall(self, data):
        self.stream.call(self.stream.tls.write, bytes(data))

    def settimeout(self, timeout):
        self.sock.settimeout(timeout)

    def shutdown(self, how):
        try:
            self.sock.shutdown(how)
        except OSError:
            pass

    def close(self):
        self.sock.close()


class TLSServer(Server):
    """HTTPS, each connection wrapped as it is accepted (a listening socket
    in a job cannot be wrapped)."""

    def __init__(self, address, handler, context):
        self.context = context
        super().__init__(address, handler)

    def get_request(self):
        sock, address = self.socket.accept()
        try:
            return self.context.wrap_socket(sock, server_side=True), address
        except OSError as err:
            sys.stderr.write(f"fake-cloud: TLS through memory BIOs (wrap_socket: {err})\n")
            return TLSConnection(sock, self.context), address

    def handle_error(self, request, client_address):
        # A client that closes without TLS's close_notify (requests does)
        # is not an error worth a traceback in the job's log.
        if not isinstance(sys.exc_info()[1], (ConnectionError, ssl.SSLError)):
            super().handle_error(request, client_address)

    def shutdown_request(self, request):
        try:
            request.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        request.close()


def main():
    args = sys.argv[1:]
    cert = key = None
    if "--cert" in args:
        cert = args[args.index("--cert") + 1]
        key = args[args.index("--key") + 1]
    servers = [Server(("127.0.0.1", 4566), Handler)]
    if cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        servers.append(TLSServer(("127.0.0.1", 4567), Handler, context))
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("fake-cloud listening on " + ", ".join(str(s.server_port) for s in servers), flush=True)
    servers[0].serve_forever()


if __name__ == "__main__":
    main()

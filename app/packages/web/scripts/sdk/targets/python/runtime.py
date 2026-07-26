"""The hand-written half of the generated Python SDK.

This module is **not imported by anything in this repo** — the generator reads
it off disk and writes everything below the sentinel out as
``infrawrench_sdk/_transport.py``, under the usual generated-file banner.
Keeping it as real Python (rather than a template string inside ``index.ts``)
means it can be run, linted and type-checked like any other source file, so a
mistake in the request plumbing shows up here instead of in generated output
nobody reads.

Three tokens are substituted at generation time — see ``SUBSTITUTIONS`` in
``./index.ts``. They are written as plain literals so this file still parses,
imports and type-checks on its own.

Nothing here may import a third-party package: the published distribution has
no dependencies and must run on a stock CPython 3.9.
"""

# --8<-- everything below this line is copied into the generated SDK --8<--

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union

# Replaced with the first server advertised by the spec.
DEFAULT_BASE_URL = "@@BASE_URL@@"

# Replaced with the path parameter the client carries as configuration
# (``orgId``), and the constructor keyword that supplies it — or ``None`` when
# the API has no such parameter.
SCOPE_PARAM: Optional[str] = "@@SCOPE_PARAM@@"
SCOPE_KWARG: Optional[str] = "@@SCOPE_KWARG@@"

# What a ``format: binary`` field accepts. Bare bytes are uploaded under the
# field's own name; the tuple forms let a caller pin the filename and, with the
# three-element form, the part's content type.
FileUpload = Union[
    bytes,
    bytearray,
    Tuple[str, Union[bytes, bytearray]],
    Tuple[str, Union[bytes, bytearray], str],
]

_PLACEHOLDER = re.compile(r"\{([^}]+)\}")

_CRLF = b"\r\n"

_DEFAULT_PART_TYPE = "application/octet-stream"


@dataclass
class ClientOptions:
    """Everything :class:`APIV1Client` can be configured with.

    Passed either as keyword arguments to the client — the usual way — or as a
    prebuilt instance via ``options=``, which is handy when the configuration
    is assembled somewhere other than the call site.
    """

    #: Base URL of the deployment. Defaults to the production API.
    base_url: Optional[str] = None
    #: API key or WorkOS access token, sent as ``Authorization: Bearer <token>``.
    #: Omit it only if you are supplying the header yourself.
    api_key: Optional[str] = None
    #: Default organization id. Every org-scoped call accepts ``org_id``; set it
    #: here once and you can leave it off the call sites.
    org_id: Optional[str] = None
    #: Headers merged into every request. Per-call headers win.
    headers: Optional[Mapping[str, str]] = None
    #: Socket timeout in seconds, applied to every request. No timeout by default.
    timeout: Optional[float] = None
    #: Swap the URL opener — for proxies, custom TLS contexts, or tests.
    opener: Optional[urllib.request.OpenerDirector] = None


@dataclass
class RequestOptions:
    """Per-call overrides, accepted as ``request_options`` by every method."""

    #: Headers for this call only, merged over the client-wide ones.
    headers: Optional[Mapping[str, str]] = None
    #: Timeout in seconds for this call only, overriding the client-wide one.
    timeout: Optional[float] = None


class ApiError(Exception):
    """Raised for any non-2xx response.

    The parsed response body is on :attr:`body`, and :attr:`code` carries the
    machine-readable discriminator when the API sends one (for example
    ``reauthentication_required`` on a step-up 403) — branch on that, not on the
    message.
    """

    def __init__(
        self,
        *,
        status: int,
        message: str,
        code: Optional[str],
        body: Any,
        method: str,
        url: str,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body
        self.method = method
        self.url = url

    def __repr__(self) -> str:
        return "ApiError(status={0!r}, code={1!r}, method={2!r}, url={3!r})".format(
            self.status, self.code, self.method, self.url
        )


@dataclass
class Response:
    """A raw HTTP response, as returned by :meth:`ApiTransport.send`."""

    status: int
    #: Header names lowercased, so lookups don't have to guess the casing.
    headers: Dict[str, str] = field(default_factory=dict)
    body: bytes = b""


class ApiTransport:
    """Request plumbing shared by every namespace.

    Public because the generated namespace classes take one in their
    constructor and because :meth:`send` is the documented seam for tests and
    proxies — but reach for :class:`APIV1Client` to make actual calls.
    """

    def __init__(self, options: Optional[ClientOptions] = None, **overrides: Any) -> None:
        config = options if options is not None else ClientOptions()
        for key, value in overrides.items():
            if not hasattr(config, key):
                raise TypeError("Unknown client option {0!r}".format(key))
            if value is not None:
                setattr(config, key, value)

        #: Normalized base URL, without a trailing slash.
        self.base_url = (config.base_url or DEFAULT_BASE_URL).rstrip("/")
        self._api_key = config.api_key
        self._defaults: Dict[str, Optional[str]] = (
            {} if SCOPE_PARAM is None else {SCOPE_PARAM: config.org_id}
        )
        self._headers = {key.lower(): value for key, value in (config.headers or {}).items()}
        self._timeout = config.timeout
        self._opener = config.opener or urllib.request.build_opener()

    def request(
        self,
        *,
        method: str,
        path: str,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        form: Optional[Mapping[str, Any]] = None,
        accept: str = "json",
        options: Optional[RequestOptions] = None,
    ) -> Any:
        """Perform one call and decode its response according to ``accept``."""
        route = self._resolve_path(method, path, path_params)
        url = self.base_url + route + _encode_query(query)

        headers = {
            "accept": "application/octet-stream" if accept == "binary" else "application/json"
        }
        headers.update(self._headers)
        if options is not None and options.headers:
            headers.update({key.lower(): value for key, value in options.headers.items()})
        if self._api_key:
            headers["authorization"] = "Bearer {0}".format(self._api_key)

        data: Optional[bytes] = None
        if form is not None:
            data, content_type = _encode_multipart(form)
            headers["content-type"] = content_type
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"

        timeout = self._timeout
        if options is not None and options.timeout is not None:
            timeout = options.timeout

        response = self.send(method.upper(), url, headers, data, timeout)

        if not 200 <= response.status < 300:
            raise _to_api_error(response, method.upper(), url)
        if accept == "binary":
            return response.body
        if accept == "empty" or response.status in (204, 205) or not response.body:
            return None
        text = response.body.decode("utf-8", "replace")
        if "json" not in response.headers.get("content-type", ""):
            return text
        return json.loads(text)

    def send(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        data: Optional[bytes],
        timeout: Optional[float],
    ) -> Response:
        """Put one prepared request on the wire.

        The single point where this package touches the network, so overriding
        it — in a subclass or by assignment — is all it takes to record, replay
        or fake every call the client makes.
        """
        request = urllib.request.Request(url=url, data=data, method=method)
        for key, value in headers.items():
            request.add_header(key, value)
        try:
            raw = (
                self._opener.open(request)
                if timeout is None
                else self._opener.open(request, timeout=timeout)
            )
        except urllib.error.HTTPError as error:
            # urllib raises on 4xx/5xx rather than returning them. The error is
            # itself a readable response, and `ApiError` is a better shape to
            # hand a caller than `HTTPError`, so unwrap it here.
            with error:
                return Response(error.code, _lower_headers(error.headers), error.read())
        with raw:
            return Response(raw.status, _lower_headers(raw.headers), raw.read())

    def _resolve_path(
        self, method: str, path: str, path_params: Optional[Mapping[str, Any]]
    ) -> str:
        """Fill ``{param}`` placeholders from the call, falling back to config."""

        def replace(match: "re.Match[str]") -> str:
            name = match.group(1)
            value = None if path_params is None else path_params.get(name)
            if value is None:
                value = self._defaults.get(name)
            if value is None or value == "":
                hint = "."
                if name == SCOPE_PARAM:
                    hint = " — pass {0}=..., or set it when constructing the client.".format(
                        SCOPE_KWARG
                    )
                raise ValueError(
                    'Missing path parameter "{0}" for {1} {2}{3}'.format(
                        name, method.upper(), path, hint
                    )
                )
            return urllib.parse.quote(_to_str(value), safe="")

        return _PLACEHOLDER.sub(replace, path)


def _to_str(value: Any) -> str:
    """Render a scalar the way the API reads it, not the way Python prints it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value)
    return str(value)


def _encode_query(query: Optional[Mapping[str, Any]]) -> str:
    if not query:
        return ""
    pairs: List[Tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            pairs.extend((key, _to_str(item)) for item in value if item is not None)
        else:
            pairs.append((key, _to_str(value)))
    return "?" + urllib.parse.urlencode(pairs) if pairs else ""


def _lower_headers(headers: Any) -> Dict[str, str]:
    if headers is None:
        return {}
    items = headers.items() if hasattr(headers, "items") else headers
    return {str(key).lower(): str(value) for key, value in items}


def _escape_quotes(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _multipart_part(name: str, value: Any) -> bytes:
    filename: Optional[str] = None
    content_type: Optional[str] = None
    if isinstance(value, tuple):
        filename = str(value[0])
        payload = bytes(value[1])
        if len(value) > 2:
            content_type = str(value[2])
    elif isinstance(value, (bytes, bytearray)):
        # A bare buffer still has to be sent as a file part, or the server sees
        # a text field. The field name is the only filename available.
        filename = name
        payload = bytes(value)
    else:
        payload = _to_str(value).encode("utf-8")

    disposition = 'form-data; name="{0}"'.format(_escape_quotes(name))
    if filename is not None:
        disposition += '; filename="{0}"'.format(_escape_quotes(filename))
        content_type = content_type or _DEFAULT_PART_TYPE

    out = bytearray()
    out += b"Content-Disposition: " + disposition.encode("utf-8") + _CRLF
    if content_type is not None:
        out += b"Content-Type: " + content_type.encode("utf-8") + _CRLF
    out += _CRLF + payload + _CRLF
    return bytes(out)


def _encode_multipart(fields: Mapping[str, Any]) -> Tuple[bytes, str]:
    """Serialize ``multipart/form-data`` by hand — stdlib has no encoder."""
    boundary = "----infrawrench{0}".format(uuid.uuid4().hex)
    marker = boundary.encode("ascii")
    out = bytearray()
    for name, value in fields.items():
        if value is None:
            continue
        # A list means the same field repeated; a tuple is one file spec.
        parts = value if isinstance(value, list) else [value]
        for part in parts:
            if part is None:
                continue
            out += b"--" + marker + _CRLF + _multipart_part(name, part)
    out += b"--" + marker + b"--" + _CRLF
    return bytes(out), "multipart/form-data; boundary={0}".format(boundary)


def _to_api_error(response: Response, method: str, url: str) -> ApiError:
    text = response.body.decode("utf-8", "replace") if response.body else ""
    body: Any = text
    if text:
        try:
            body = json.loads(text)
        except ValueError:
            pass  # Not JSON — keep the raw text as the body.
    record = body if isinstance(body, dict) else {}
    detail = record.get("error") or record.get("message")
    if not isinstance(detail, str):
        detail = "{0} Request failed".format(response.status)
    code = record.get("code")
    return ApiError(
        status=response.status,
        message="{0} {1} failed: {2}".format(method, url, detail),
        code=code if isinstance(code, str) else None,
        body=body,
        method=method,
        url=url,
    )

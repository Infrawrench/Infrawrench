// The generated crate's smoke test, shipped with it and copied verbatim by the
// generator into `tests/smoke.rs`.
//
// It is deliberately pinned to real operations rather than written against some
// abstraction: the point is to prove that the *emitted* names, namespaces and
// parameter structs compose into calls that build the URLs and bodies the spec
// describes. If the spec moves an operation, this file stops compiling — which
// is the alarm going off, not a false positive.
//
// The server is a bare `TcpListener` on a background thread so the crate's test
// dependencies stay at "a runtime to drive the futures" and nothing else.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::thread;

use infrawrench_sdk::*;

/// One request as the stub server saw it.
struct Recorded {
    line: String,
    headers: Vec<(String, String)>,
    body: String,
}

/// Serve exactly `responses.len()` requests from a throwaway port, recording
/// each one. Returns the base URL to point a client at.
fn stub(responses: Vec<(u16, &'static str)>) -> (String, Receiver<Recorded>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let (sender, receiver) = mpsc::channel();

    thread::spawn(move || {
        for (status, payload) in responses {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));

            let mut line = String::new();
            reader.read_line(&mut line).expect("request line");

            let mut headers = Vec::new();
            let mut length = 0usize;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).expect("header");
                let header = header.trim_end().to_owned();
                if header.is_empty() {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().expect("content-length");
                    }
                    headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
                }
            }

            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).expect("body");
            sender
                .send(Recorded {
                    line: line.trim_end().to_owned(),
                    headers,
                    body: String::from_utf8_lossy(&body).into_owned(),
                })
                .expect("record");

            let response = format!(
                "HTTP/1.1 {status} STATUS\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            stream.write_all(response.as_bytes()).expect("write");
            stream.flush().expect("flush");
        }
    });

    (format!("http://{addr}"), receiver)
}

fn client(base: &str, org: Option<&str>) -> APIV1Client {
    let mut config = ClientConfig::new().base_url(base).api_key("iw_test");
    if let Some(org) = org {
        config = config.org_id(org);
    }
    APIV1Client::new(config).expect("client")
}

#[tokio::test]
async fn fills_the_org_id_in_from_client_config() {
    let (base, requests) = stub(vec![(200, "[]")]);
    let client = client(&base, Some("org_1"));

    let accounts = client
        .accounts()
        .list(AccountsListParams::new())
        .await
        .expect("list");
    assert!(accounts.is_empty());

    let request = requests.recv().expect("recorded");
    assert_eq!(request.line, "GET /api/org/org_1/accounts HTTP/1.1");
    assert!(
        request
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer iw_test"),
        "missing bearer header: {:?}",
        request.headers
    );
}

#[tokio::test]
async fn a_per_call_org_id_wins_and_is_percent_encoded() {
    let (base, requests) = stub(vec![(200, "[]")]);
    let client = client(&base, Some("org_1"));

    client
        .accounts()
        .list(AccountsListParams::new().org_id("org/2"))
        .await
        .expect("list");

    let request = requests.recv().expect("recorded");
    assert_eq!(request.line, "GET /api/org/org%2F2/accounts HTTP/1.1");
}

#[tokio::test]
async fn path_and_query_parameters_reach_the_url() {
    let (base, requests) = stub(vec![(200, "[]")]);
    let client = client(&base, Some("org_1"));

    client
        .accounts()
        .resources(
            AccountsResourcesParams::new("account-1")
                .top_level_only(AccountsResourcesTopLevelOnly::True),
        )
        .await
        .expect("resources");

    let request = requests.recv().expect("recorded");
    assert_eq!(
        request.line,
        "GET /api/org/org_1/accounts/account-1/resources?topLevelOnly=true HTTP/1.1"
    );
}

#[tokio::test]
async fn an_absent_query_parameter_is_omitted_entirely() {
    let (base, requests) = stub(vec![(200, "[]")]);
    let client = client(&base, Some("org_1"));

    client
        .accounts()
        .resources(AccountsResourcesParams::new("account-1"))
        .await
        .expect("resources");

    let request = requests.recv().expect("recorded");
    assert_eq!(
        request.line,
        "GET /api/org/org_1/accounts/account-1/resources HTTP/1.1"
    );
}

#[tokio::test]
async fn posts_a_json_body() {
    let (base, requests) = stub(vec![(
        200,
        r#"{"id":"00000000-0000-0000-0000-000000000001"}"#,
    )]);
    let client = client(&base, Some("org_1"));

    let mut credentials = HashMap::new();
    credentials.insert("apiKey".to_owned(), "secret".to_owned());

    let created = client
        .accounts()
        .create(AccountsCreateParams::new(CreateAccountRequest {
            plugin_id: "cloudflare".to_owned(),
            display_name: "Prod".to_owned(),
            credentials,
            bastion_id: None,
        }))
        .await
        .expect("create");
    assert_eq!(created.id, "00000000-0000-0000-0000-000000000001");

    let request = requests.recv().expect("recorded");
    assert_eq!(request.line, "POST /api/org/org_1/accounts HTTP/1.1");
    let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
    assert_eq!(body["pluginId"], "cloudflare");
    assert_eq!(body["displayName"], "Prod");
    assert_eq!(body["credentials"]["apiKey"], "secret");
    // `bastionId` is optional, so `None` means "leave the key out" rather than
    // "send null".
    assert!(body.get("bastionId").is_none(), "{body}");
}

#[tokio::test]
async fn reaches_a_deep_namespace() {
    let (base, requests) = stub(vec![(
        200,
        r#"{"version":{"id":"v1","state":"ENABLED","createdAt":"2026-01-01T00:00:00Z"}}"#,
    )]);
    let client = client(&base, Some("org_1"));

    let added = client
        .resources()
        .secret_versions()
        .add(ResourcesSecretVersionsAddParams::new(
            PluginId::Aws,
            ResourceTypeId::SecretsManagerSecret,
            SecretAddRequest {
                account_id: "account-1".to_owned(),
                resource_id: "aws:account-1:secret".to_owned(),
                value: "hunter2".to_owned(),
                parent_resource_id: None,
            },
        ))
        .await
        .expect("add");
    assert_eq!(added.version.state, SecretVersionState::Enabled);

    let request = requests.recv().expect("recorded");
    assert_eq!(
        request.line,
        "POST /api/org/org_1/resources/aws/secrets-manager-secret/secret-versions/add HTTP/1.1"
    );
    let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
    assert_eq!(body["value"], "hunter2");
}

#[tokio::test]
async fn a_non_2xx_response_becomes_an_api_error() {
    let (base, _requests) = stub(vec![(
        403,
        r#"{"error":"Step up required","code":"reauthentication_required"}"#,
    )]);
    let client = client(&base, Some("org_1"));

    let error = client
        .accounts()
        .list(AccountsListParams::new())
        .await
        .expect_err("should fail");

    assert_eq!(error.status(), Some(403));
    assert_eq!(error.code(), Some("reauthentication_required"));
    let api = error.api().expect("api error");
    assert_eq!(api.body["error"], "Step up required");
    assert!(api.message.contains("Step up required"), "{}", api.message);
    assert!(error.to_string().contains("Step up required"));
}

#[tokio::test]
async fn a_missing_org_id_fails_before_anything_is_sent() {
    // Port 9 is discard; nothing should ever get that far.
    let client = client("http://127.0.0.1:9", None);

    let error = client
        .accounts()
        .list(AccountsListParams::new())
        .await
        .expect_err("should fail");

    match &error {
        Error::MissingPathParam { name, method, path } => {
            assert_eq!(name, "orgId");
            assert_eq!(method, "GET");
            assert_eq!(path, "/api/org/{orgId}/accounts");
        }
        other => panic!("expected a missing path parameter, got {other:?}"),
    }
    let message = error.to_string();
    assert!(message.contains("ClientConfig"), "{message}");
}

#[test]
fn an_unknown_enum_value_round_trips_instead_of_failing() {
    let known: PluginId = serde_json::from_str("\"aws\"").expect("known");
    assert_eq!(known, PluginId::Aws);

    let unknown: PluginId = serde_json::from_str("\"something-new\"").expect("unknown");
    assert_eq!(unknown, PluginId::Other("something-new".to_owned()));
    assert_eq!(
        serde_json::to_string(&unknown).expect("serialize"),
        "\"something-new\""
    );
}

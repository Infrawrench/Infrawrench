//! Keeps `schema/ci.schema.json` (what editors validate against) in step
//! with the structs serde actually accepts. serde's own "unknown field"
//! error lists every field a struct expects, so each case below plants an
//! unknown key at one position and compares that list with the schema's
//! `properties` at the same position.

use std::collections::BTreeSet;

fn schema() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../schema/ci.schema.json")).unwrap()
}

fn expected_fields(yaml: &str) -> BTreeSet<String> {
    let err = iwci_spec::parse(yaml, &Default::default())
        .unwrap_err()
        .to_string();
    let list = err
        .split("expected one of ")
        .nth(1)
        .or_else(|| err.split("expected ").nth(1))
        .unwrap_or_else(|| panic!("no field list in: {err}"));
    let list = list.split(" at line").next().unwrap();
    // serde writes two fields as "`a` or `b`" and more as "`a`, `b`, `c`".
    list.replace("` or `", "`, `")
        .split(", ")
        .map(|f| f.trim_matches('`').to_string())
        .collect()
}

fn schema_fields(pointer: &str) -> BTreeSet<String> {
    let schema = schema();
    let node = schema
        .pointer(pointer)
        .unwrap_or_else(|| panic!("no {pointer} in schema"));
    node["properties"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

#[test]
fn schema_matches_the_structs() {
    let cases = [
        ("zzz: 1\nname: x\njobs: {}\n", ""),
        (
            "name: x\njobs:\n  a:\n    using: builtin:t@1\n    zzz: 1\n",
            "/$defs/job",
        ),
        (
            "name: x\nworkspace:\n  zzz: 1\njobs: {}\n",
            "/properties/workspace",
        ),
        (
            "name: x\nworkspace:\n  clone: { zzz: 1 }\njobs: {}\n",
            "/$defs/clone",
        ),
        ("name: x\non:\n  zzz: {}\njobs: {}\n", "/properties/on"),
        (
            "name: x\non:\n  push: { zzz: 1 }\njobs: {}\n",
            "/$defs/triggerFilter",
        ),
        (
            "name: x\njobs:\n  a:\n    using: builtin:t@1\n    cache: { zzz: 1 }\n",
            "/$defs/cacheEntry",
        ),
    ];
    for (yaml, pointer) in cases {
        assert_eq!(
            expected_fields(yaml),
            schema_fields(pointer),
            "schema at `{pointer}` disagrees with the struct"
        );
    }
}

#[test]
fn the_example_uses_only_schema_keys() {
    // A cheap structural check: every job key in the example is a schema
    // property, so the example cannot drift into something editors flag.
    let example: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(include_str!("../../../examples/tests.yml")).unwrap();
    let job_keys = schema_fields("/$defs/job");
    for (_, job) in example["jobs"].as_mapping().unwrap() {
        for (k, _) in job.as_mapping().unwrap() {
            assert!(
                job_keys.contains(k.as_str().unwrap()),
                "{k:?} is not in the schema"
            );
        }
    }
}

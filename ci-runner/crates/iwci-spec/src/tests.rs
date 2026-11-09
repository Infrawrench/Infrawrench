use super::*;

fn ctx() -> Context {
    Context {
        commit_sha: "0123456789abcdef0123456789abcdef01234567".into(),
        branch: "main".into(),
        repo_id: "repo_1".into(),
        event: Event::Push,
        vars: Default::default(),
        packages: PackagesSource::Unknown,
    }
}

fn first(plan: &Plan) -> &PlannedJob {
    plan.static_jobs().next().unwrap()
}

fn second(plan: &Plan) -> &PlannedJob {
    plan.static_jobs().nth(1).unwrap()
}

fn ids(plan: &Plan) -> Vec<String> {
    plan.static_jobs().map(|j| j.id.clone()).collect()
}

fn errors(yaml: &str) -> Vec<String> {
    match parse(yaml, &ctx()) {
        Ok(_) => panic!("expected errors"),
        Err(e) => {
            e.0.into_iter()
                .map(|e| format!("{}: {}", e.path, e.message))
                .collect()
        }
    }
}

fn assert_error(yaml: &str, needle: &str) {
    let errs = errors(yaml);
    assert!(
        errs.iter().any(|e| e.contains(needle)),
        "no error containing {needle:?} in {errs:#?}"
    );
}

#[test]
fn the_example_pipeline_expands() {
    let plan = parse(include_str!("../../../examples/tests.yml"), &ctx()).unwrap();
    assert_eq!(
        ids(&plan),
        [
            "typescript[web]",
            "typescript[mobile]",
            "format",
            "gofmt",
            "go-modules",
            "lint[web]",
            "lint[desktop]"
        ]
    );
    let web = plan.job("typescript[web]").unwrap();
    assert_eq!(web.display_name, "TypeScript (web)");
    assert_eq!(web.cwd, "/app/app/packages/web");
    assert_eq!(
        web.action,
        Action::Args {
            args: vec!["--noEmit".into()]
        }
    );
    assert_eq!(
        web.tool,
        ToolRef::Builtin {
            name: "typescript".into(),
            version: "7.1".into()
        }
    );
    assert_eq!(web.timeout.as_secs(), DEFAULT_TIMEOUT_SECS);

    // typescript and lint share the pnpm workspace; format and gofmt share
    // the clone-only one; go-modules has its own.
    assert_eq!(plan.workspaces.len(), 3);
    assert_eq!(web.workspace, plan.job("lint[web]").unwrap().workspace);
    assert_eq!(
        plan.job("format").unwrap().workspace,
        plan.job("gofmt").unwrap().workspace
    );
    assert_ne!(web.workspace, plan.job("format").unwrap().workspace);
    let go_ws = &plan.workspaces[plan.job("go-modules").unwrap().workspace];
    assert_eq!(
        go_ws.deps,
        vec![DepSpec {
            ecosystem: Ecosystem::Go,
            dir: "/app/terraform-provider-infrawrench".into(),
            only: None
        }]
    );

    assert_eq!(
        plan.job("format").unwrap().changes,
        ChangePolicy::Commit {
            message: "style: format".into()
        }
    );
    assert_eq!(plan.job("gofmt").unwrap().changes, ChangePolicy::Fail);

    let lint = plan.job("lint[desktop]").unwrap();
    assert_eq!(lint.display_name, "Lint (desktop)");
    assert_eq!(plan.template("lint").unwrap().needs, vec!["typescript"]);
    assert_eq!(lint.memory_bytes, 4 << 30);
    assert_eq!(lint.timeout.as_secs(), 15 * 60);
    assert!(matches!(&lint.action, Action::Script { script } if script.contains("pnpm run lint")));

    let order: Vec<&str> = plan
        .topological_order()
        .iter()
        .map(|t| t.key.as_str())
        .collect();
    assert!(
        order.iter().position(|i| *i == "lint") > order.iter().position(|i| *i == "typescript")
    );
}

#[test]
fn the_original_sketch_gets_pointed_errors() {
    // The first draft of the format, which this one replaced: every changed
    // key should say what to write instead.
    let errs = errors(
        r#"
name: Tests
jobs:
  typescript:
    matrix: [web, mobile]
    git-clone: { method: shallow, into: /app }
    download-deps-with: pnpm
    using: builtin:typescript-7.1
"#,
    );
    assert_eq!(errs.len(), 1, "{errs:?}");
    assert!(errs[0].contains("unknown field `git-clone`"), "{errs:?}");
}

#[test]
fn tool_references_must_be_pinned_and_well_formed() {
    let job = |using: &str| format!("name: x\njobs:\n  a:\n    using: {using}\n");
    assert_error(&job("builtin:typescript"), "has no version");
    assert_error(&job("typescript@7"), "not a tool reference");
    assert_error(&job("docker:node@1"), "unknown tool kind");
    assert_error(&job("builtin:TypeScript@7"), "not a valid tool name");
    assert_error(&job("builtin:typescript@7.x"), "not a version");
    assert_error(&job("builtin:typescript@7-beta"), "not a version");
    assert!(parse(&job("builtin:typescript@7.1.0-beta.2"), &ctx()).is_ok());
    assert!(parse(&job("repo:licence-check@2"), &ctx()).is_ok());
}

#[test]
fn environments_take_scripts_and_tools_take_args() {
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n",
        "give the job a `run:` script",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    run: echo\n    args: [x]\n",
        "not `args:`",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:gofmt@1\n    run: echo\n",
        "is a tool",
    );
}

#[test]
fn matrix_rules() {
    let plan = parse(
        r#"
name: x
jobs:
  t:
    using: builtin:t@1
    matrix:
      os: [linux, wasi]
      mode: [strict, loose]
      exclude:
        - { os: wasi, mode: loose }
    args: ["--os=${{ matrix.os }}", "${{ matrix.mode }}"]
"#,
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        ids(&plan),
        ["t[linux,strict]", "t[linux,loose]", "t[wasi,strict]"]
    );
    let jobs: Vec<&PlannedJob> = plan.static_jobs().collect();
    assert_eq!(
        jobs[2].action,
        Action::Args {
            args: vec!["--os=wasi".into(), "strict".into()]
        }
    );
    assert_eq!(jobs[1].display_name, "t (linux, loose)");

    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: [a, a]\n",
        "lists `a` twice",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: [a]\n    args: [\"${{ matrix.x }}\"]\n",
        "plain list",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: { os: [a] }\n    args: [\"${{ matrix }}\"]\n",
        "named axes",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: { os: [a] }\n    args: [\"${{ matrix.cpu }}\"]\n",
        "no axis `cpu`",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    args: [\"${{ matrix }}\"]\n",
        "has no matrix",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: { os: [a], exclude: [{ os: a }] }\n",
        "removes every combination",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: [\"a,b\"]\n",
        "cannot be empty",
    );
    let big: Vec<String> = (0..65).map(|i| i.to_string()).collect();
    assert_error(
        &format!(
            "name: x\njobs:\n  t:\n    using: builtin:t@1\n    matrix: [{}]\n",
            big.join(",")
        ),
        "the limit is 64",
    );
}

#[test]
fn expressions() {
    let plan = parse(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    args: \"--sha ${{ commit.sha }} --short '${{ commit.short-sha }}' ${{repo.id}}\"\n    env:\n      BRANCH: ${{ commit.branch }}\n",
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        first(&plan).action,
        Action::Args {
            args: vec![
                "--sha".into(),
                "0123456789abcdef0123456789abcdef01234567".into(),
                "--short".into(),
                "0123456789ab".into(),
                "repo_1".into()
            ]
        }
    );
    assert_eq!(
        first(&plan).env,
        vec![("BRANCH".to_string(), "main".to_string())]
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    args: [\"${{ secrets.TOKEN }}\"]\n",
        "secrets can only be used in `env:` values",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    args: [\"${{ commit.sha\"]\n",
        "never closed",
    );
}

#[test]
fn one_line_args_split_like_a_shell_without_expanding() {
    let plan = parse(
        r#"
name: x
jobs:
  t:
    using: builtin:t@1
    args: --a "two words" 'single $HOME' esc\ aped "q\"uote"
"#,
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        first(&plan).action,
        Action::Args {
            args: vec![
                "--a".into(),
                "two words".into(),
                "single $HOME".into(),
                "esc aped".into(),
                "q\"uote".into()
            ]
        }
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    args: \"a 'b\"\n",
        "unclosed",
    );
}

#[test]
fn paths_and_workspaces() {
    assert_error(
        "name: x\nworkspace:\n  clone: { into: app }\njobs:\n  t:\n    using: builtin:t@1\n",
        "must be an absolute path below",
    );
    assert_error(
        "name: x\nworkspace:\n  clone: { into: / }\njobs:\n  t:\n    using: builtin:t@1\n",
        "must be an absolute path below",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    cwd: /app/../etc\n",
        "without `..`",
    );
    assert_error(
        "name: x\nworkspace:\n  deps: [{ pnpm: { dir: ../x } }]\njobs:\n  t:\n    using: builtin:t@1\n",
        "inside the clone",
    );
    assert_error(
        "name: x\nworkspace:\n  deps: [npm]\njobs:\n  t:\n    using: builtin:t@1\n",
        "unknown ecosystem `npm`",
    );
    assert_error(
        "name: x\nworkspace:\n  deps: [{ go: { only: [a] } }]\njobs:\n  t:\n    using: builtin:t@1\n",
        "only applies to pnpm",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    clone: false\n    deps: [pnpm]\n",
        "need a clone",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    clone: false\n    changes: fail\n",
        "no repository to change",
    );
    assert_error(
        "name: x\nworkspace:\n  clone: { depth: 0 }\njobs:\n  t:\n    using: builtin:t@1\n",
        "at least 1",
    );
    assert_error(
        "name: x\nworkspace:\n  clone: { depth: shallow }\njobs:\n  t:\n    using: builtin:t@1\n",
        "not a depth",
    );

    let plan = parse("name: x\nworkspace:\n  clone: { depth: full }\njobs:\n  t:\n    using: builtin:t@1\n  u:\n    using: builtin:u@1\n    clone: false\n", &ctx()).unwrap();
    assert_eq!(
        plan.workspaces[first(&plan).workspace]
            .clone
            .as_ref()
            .unwrap()
            .depth,
        CloneDepth::Full
    );
    assert_eq!(first(&plan).cwd, "/app");
    assert!(plan.workspaces[second(&plan).workspace].clone.is_none());
    assert_eq!(second(&plan).cwd, "/");
}

#[test]
fn needs_limits_and_policies() {
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    needs: [b]\n  b:\n    using: builtin:t@1\n    needs: [a]\n",
        "forms a cycle",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    needs: [a]\n",
        "cannot need itself",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    needs: [zzz]\n",
        "no job named `zzz`",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    timeout: 2h\n",
        "between 1s and 60m",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    timeout: \"10\"\n",
        "not a duration",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    memory: 32GiB\n",
        "between 16MiB and 16GiB",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    memory: lots\n",
        "not a size",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    changes: commit\n",
        "not a policy",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    changes: { commit: \"\" }\n",
        "needs a commit message",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    env: { IWCI_X: y }\n",
        "set by the runner",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    env: { 1X: y }\n",
        "not a valid environment variable",
    );
    assert_error(
        "name: x\njobs:\n  Bad:\n    using: builtin:t@1\n",
        "job keys use",
    );
    assert_error("name: x\njobs: {}\n", "at least one job");
    assert_error(
        "name: x\non: {}\njobs:\n  a:\n    using: builtin:t@1\n",
        "lists no events",
    );
    let plan = parse(
        "name: x\njobs:\n  a:\n    using: builtin:t@1\n    timeout: 1h\n    memory: 512MiB\n",
        &ctx(),
    )
    .unwrap();
    assert_eq!(first(&plan).timeout.as_secs(), 3600);
    assert_eq!(first(&plan).memory_bytes, 512 << 20);
}

#[test]
fn all_errors_are_reported_at_once() {
    let errs = errors(
        "name: \"\"\njobs:\n  a:\n    using: nope\n  b:\n    using: builtin:t@1\n    timeout: forever\n",
    );
    assert_eq!(errs.len(), 3, "{errs:#?}");
}

#[test]
fn triggers() {
    let plan = parse(include_str!("../../../examples/tests.yml"), &ctx()).unwrap();
    assert!(plan.triggers.matches(Event::Push, "main", None));
    assert!(!plan.triggers.matches(Event::Push, "feature/x", None));
    assert!(plan.triggers.matches(Event::PullRequest, "feature/x", None));

    let plan = parse("name: x\non:\n  push: { branches: [\"release/*\"], paths: [\"app/**\"] }\njobs:\n  a:\n    using: builtin:t@1\n", &ctx()).unwrap();
    assert!(
        plan.triggers
            .matches(Event::Push, "release/1.0", Some(&["app/a.ts".into()]))
    );
    assert!(!plan.triggers.matches(Event::Push, "release/1.0/x", None));
    assert!(
        !plan
            .triggers
            .matches(Event::Push, "release/1.0", Some(&["docs/a.md".into()]))
    );
    assert!(
        !plan
            .triggers
            .matches(Event::PullRequest, "release/1.0", None)
    );

    // No `on:` runs on every push.
    let plan = parse("name: x\njobs:\n  a:\n    using: builtin:t@1\n", &ctx()).unwrap();
    assert!(plan.triggers.matches(Event::Push, "anything", None));
}

#[test]
fn filters_take_exclusions() {
    let plan = parse(
        "name: x\non:\n  push:\n    branches: [\"**\", \"!dependabot/**\"]\n    paths: [app/**, \"!app/docs/**\"]\njobs:\n  a:\n    using: builtin:t@1\n    paths: [\"!**/*.md\"]\n",
        &ctx(),
    )
    .unwrap();
    let t = &plan.triggers;
    assert!(t.matches(Event::Push, "main", Some(&["app/web/a.ts".into()])));
    assert!(!t.matches(Event::Push, "dependabot/npm/x", None));
    assert!(!t.matches(Event::Push, "main", Some(&["app/docs/a.md".into()])));
    assert!(
        t.matches(
            Event::Push,
            "main",
            Some(&["app/docs/a.md".into(), "app/web/a.ts".into()])
        ),
        "one path let through is enough"
    );
    let a = plan.template("a").unwrap();
    assert!(a.affected_by(Some(&["src/lib.rs".into()])));
    assert!(!a.affected_by(Some(&["README.md".into(), "docs/x.md".into()])));

    let bad = "name: x\njobs:\n  a:\n    using: builtin:t@1\n    paths: [\"!\"]\n";
    let err = parse(bad, &ctx()).unwrap_err().to_string();
    assert!(
        err.contains("jobs.a.paths") && err.contains("nothing to match"),
        "{err}"
    );
}

#[test]
fn an_unquoted_exclusion_is_an_error_not_a_silent_tag() {
    let yaml = "name: x\njobs:\n  a:\n    using: builtin:t@1\n    paths:\n      - !docs/**\n";
    let err = parse(yaml, &ctx()).unwrap_err().to_string();
    assert!(
        err.contains("jobs.a.paths") && err.contains("has to be quoted"),
        "{err}"
    );
}

#[test]
fn job_paths_filter() {
    let plan = parse(include_str!("../../../examples/tests.yml"), &ctx()).unwrap();
    let gofmt = plan.template("gofmt").unwrap();
    assert!(gofmt.affected_by(Some(&["terraform-provider-infrawrench/main.go".into()])));
    assert!(!gofmt.affected_by(Some(&["app/packages/web/src/a.ts".into()])));
    assert!(gofmt.affected_by(None));
    assert!(
        plan.template("format")
            .unwrap()
            .affected_by(Some(&["anything".into()]))
    );
}

const DYNAMIC: &str = r#"
name: x
jobs:
  detect:
    using: env:bash@5
    outputs: [packages, docs-only]
    run: echo hi
  typecheck:
    needs: [detect]
    matrix: ${{ needs.detect.outputs.packages }}
    using: builtin:typescript@7
    cwd: /app/app/packages/${{ matrix }}
    args: [--noEmit]
  axes:
    needs: [detect]
    matrix:
      package: ${{ needs.detect.outputs.packages }}
      mode: [strict]
    using: builtin:t@1
    args: ["${{ matrix.package }}-${{ matrix.mode }}"]
  docs:
    needs: [detect]
    if: needs.detect.outputs.docs-only == 'true'
    using: builtin:t@1
    env:
      FROM: ${{ needs.detect.result }}
  cleanup:
    needs: [typecheck]
    if: always()
    using: builtin:t@1
"#;

fn needs_with(outputs: &[(&str, &str)]) -> NeedsValues {
    let mut values = NeedsValues::default();
    values.results.insert("detect".into(), JobResult::Success);
    values.outputs.insert(
        "detect".into(),
        outputs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    );
    values
}

#[test]
fn jobs_that_read_outputs_expand_after_their_needs() {
    let plan = parse(DYNAMIC, &ctx()).unwrap();
    assert!(plan.template("detect").unwrap().instances.is_some());
    assert!(
        plan.template("typecheck").unwrap().instances.is_none(),
        "matrix from an output"
    );
    assert!(
        plan.template("axes").unwrap().instances.is_none(),
        "one axis from an output"
    );
    assert!(
        plan.template("docs").unwrap().instances.is_none(),
        "env reads needs.detect.result"
    );
    assert!(plan.template("cleanup").unwrap().instances.is_some());
    assert_eq!(
        plan.template("docs").unwrap().condition_source.as_deref(),
        Some("needs.detect.outputs.docs-only == 'true'")
    );

    let needs = needs_with(&[("packages", r#"["web","mobile"]"#)]);
    let jobs = plan.instantiate("typecheck", &needs).unwrap();
    let ids: Vec<&str> = jobs.iter().map(|j| j.id.as_str()).collect();
    assert_eq!(ids, ["typecheck[web]", "typecheck[mobile]"]);
    assert_eq!(jobs[1].cwd, "/app/app/packages/mobile");

    let jobs = plan.instantiate("axes", &needs).unwrap();
    assert_eq!(
        jobs[0].action,
        Action::Args {
            args: vec!["web-strict".into()]
        }
    );
    assert_eq!(jobs.len(), 2);

    let jobs = plan.instantiate("docs", &needs).unwrap();
    assert_eq!(
        jobs[0].env,
        vec![("FROM".to_string(), "success".to_string())]
    );

    // An object of axes works as a whole-matrix value too, and an empty
    // list is no jobs rather than an error.
    let jobs = plan
        .instantiate("typecheck", &needs_with(&[("packages", "[]")]))
        .unwrap();
    assert!(jobs.is_empty());
    let jobs = plan
        .instantiate("axes", &needs_with(&[("packages", "[]")]))
        .unwrap();
    assert!(jobs.is_empty());
    let err = plan
        .instantiate(
            "typecheck",
            &needs_with(&[("packages", r#"{"package":["web"],"os":["linux"]}"#)]),
        )
        .unwrap_err();
    assert!(
        err.to_string().contains("named axes"),
        "an axes matrix needs `matrix.<axis>`: {err}"
    );

    let err = plan
        .instantiate("typecheck", &needs_with(&[("packages", "web")]))
        .unwrap_err();
    assert!(
        err.to_string().contains("must hold a JSON list or object"),
        "{err}"
    );
    let err = plan
        .instantiate("axes", &needs_with(&[("packages", r#"{"a":1}"#)]))
        .unwrap_err();
    assert!(err.to_string().contains("must hold a JSON list"), "{err}");
    let err = plan
        .instantiate("typecheck", &needs_with(&[("packages", r#"["a","a"]"#)]))
        .unwrap_err();
    assert!(err.to_string().contains("twice"), "{err}");
}

#[test]
fn conditions_evaluate_against_needs() {
    struct Env<'a>(&'a NeedsValues, bool);
    impl expr::Env for Env<'_> {
        fn name(&self, name: &expr::Name) -> String {
            match name {
                expr::Name::NeedsOutput { job, output } => {
                    self.0.output(job, output).unwrap_or_default()
                }
                expr::Name::NeedsResult { job } => self.0.result(job).as_str().into(),
                _ => String::new(),
            }
        }
        fn all_needs_passed(&self) -> bool {
            self.1
        }
        fn changed(&self, _: &[String]) -> bool {
            true
        }
    }
    let plan = parse(DYNAMIC, &ctx()).unwrap();
    let docs = plan.template("docs").unwrap();
    assert!(docs.should_run(&Env(&needs_with(&[("docs-only", "true")]), true)));
    assert!(!docs.should_run(&Env(&needs_with(&[("docs-only", "false")]), true)));
    assert!(
        !docs.should_run(&Env(&needs_with(&[("docs-only", "true")]), false)),
        "implicit success()"
    );
    let cleanup = plan.template("cleanup").unwrap();
    assert!(cleanup.should_run(&Env(&NeedsValues::default(), false)));
    assert!(
        !plan
            .template("detect")
            .unwrap()
            .should_run(&Env(&NeedsValues::default(), false))
    );
}

#[test]
fn needs_references_are_checked_when_parsing() {
    let base = "name: x\njobs:\n  a:\n    using: env:bash@5\n    outputs: [list]\n    run: echo\n  m:\n    using: builtin:t@1\n    matrix: [x]\n";
    let job = |extra: &str| format!("{base}  b:\n    using: builtin:t@1\n{extra}");
    assert_error(
        &job("    args: [\"${{ needs.a.outputs.list }}\"]\n"),
        "not in this job's `needs:`",
    );
    assert_error(
        &job("    needs: [a]\n    args: [\"${{ needs.a.outputs.nope }}\"]\n"),
        "declares no output `nope`",
    );
    assert_error(
        &job("    needs: [a]\n    if: needs.a.outputs.nope == 'x'\n"),
        "declares no output `nope`",
    );
    assert_error(
        &job("    if: needs.a.result == 'success'\n"),
        "not in this job's `needs:`",
    );
    assert_error(
        &job("    needs: [a]\n    if: needs.a.result =\n"),
        "unexpected",
    );
    assert_error(
        &job("    needs: [a]\n    matrix: needs.a.outputs.list\n"),
        "neither a list nor",
    );
    assert_error(
        &job("    needs: [a]\n    matrix: ${{ needs.a.outputs.list }} extra\n"),
        "neither a list nor",
    );
    assert_error(
        &format!("{base}  c:\n    using: builtin:t@1\n    matrix: [x]\n    outputs: [o]\n"),
        "cannot declare outputs",
    );
    assert_error(
        &format!("{base}  c:\n    using: builtin:t@1\n    outputs: [o, o]\n"),
        "lists `o` twice",
    );
    assert_error(
        &format!("{base}  c:\n    using: builtin:t@1\n    outputs: [\"a b\"]\n"),
        "not a valid output name",
    );
    assert!(parse(&job("    needs: [a, m]\n    if: needs.m.result == 'failure' || contains(needs.a.outputs.list, 'x')\n"), &ctx()).is_ok());
}

#[test]
fn the_dynamic_example_parses() {
    let plan = parse(include_str!("../../../examples/dynamic.yml"), &ctx()).unwrap();
    assert!(plan.template("typecheck").unwrap().instances.is_none());
    assert!(
        plan.template("report").unwrap().instances.is_none(),
        "reads needs results"
    );
    assert!(plan.template("docs").unwrap().condition.is_some());
}

#[test]
fn caches_resolve_paths_and_keep_hash_files_for_the_run() {
    let plan = parse(
        r#"
name: x
jobs:
  t:
    matrix: [web]
    using: builtin:t@1
    cache:
      key: tsc-${{ matrix }}-${{ hashFiles('pnpm-lock.yaml', 'app/**/*.ts') }}
      restore-keys: ["tsc-${{ matrix }}-"]
      paths: [app/packages/web/.tsbuildinfo, /root/.cache/go-build]
"#,
        &ctx(),
    )
    .unwrap();
    let job = plan.job("t[web]").unwrap();
    assert_eq!(
        job.caches,
        vec![CacheSpec {
            key: "tsc-web-${{ hashFiles('pnpm-lock.yaml', 'app/**/*.ts') }}".into(),
            restore_keys: vec!["tsc-web-".into()],
            paths: vec![
                "/app/app/packages/web/.tsbuildinfo".into(),
                "/root/.cache/go-build".into()
            ],
        }]
    );
    let key = expand_hash_files(&job.caches[0].key, |globs| format!("h{}", globs.len())).unwrap();
    assert_eq!(key, "tsc-web-h2");

    let job =
        |cache: &str| format!("name: x\njobs:\n  t:\n    using: builtin:t@1\n    cache: {cache}\n");
    assert_error(&job("{ key: k, paths: [../x] }"), "without `..`");
    assert_error(
        &job("{ key: k, paths: [/iwci/output] }"),
        "not a path a job can cache",
    );
    assert_error(&job("{ key: k, paths: [] }"), "1 to 64 paths");
    assert_error(&job("{ key: \"\", paths: [a] }"), "1 to 512");
    assert_error(
        &job("{ key: \"${{ hashFiles(a) }}\", paths: [a] }"),
        "quoted globs",
    );
    assert_error(
        &job("{ key: \"${{ hashFiles('/etc/x') }}\", paths: [a] }"),
        "relative to the clone",
    );
    assert_error(&job("{ key: k, paths: [a], extra: 1 }"), "unknown field");
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    args: [\"${{ hashFiles('a') }}\"]\n",
        "only works in a cache",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    clone: false\n    cache: { key: k, paths: [rel] }\n",
        "only cache absolute paths",
    );
}

#[test]
fn schedules_trigger_scheduled_runs_only() {
    let plan = parse("name: x\non:\n  schedule:\n    - cron: \"0 3 * * *\"\n    - cron: \"@hourly\"\njobs:\n  a:\n    using: builtin:t@1\n    if: event == 'schedule'\n", &ctx()).unwrap();
    assert!(plan.triggers.matches(Event::Schedule, "main", None));
    assert!(
        !plan.triggers.matches(Event::Push, "main", None),
        "a schedule-only pipeline is not run on push"
    );
    assert!(plan.triggers.due(cron::Minute::from_unix(3 * 3600)));
    assert!(
        plan.triggers.due(cron::Minute::from_unix(3600 * 5)),
        "@hourly"
    );
    assert!(!plan.triggers.due(cron::Minute::from_unix(3600 * 5 + 60)));
    assert_error(
        "name: x\non:\n  schedule:\n    - cron: \"61 * * * *\"\njobs:\n  a:\n    using: builtin:t@1\n",
        "on.schedule[0].cron: minute",
    );
    assert_error(
        "name: x\non:\n  schedule:\n    - every: day\njobs:\n  a:\n    using: builtin:t@1\n",
        "unknown field",
    );
    // A push pipeline is not a scheduled one.
    let plan = parse("name: x\njobs:\n  a:\n    using: builtin:t@1\n", &ctx()).unwrap();
    assert!(!plan.triggers.matches(Event::Schedule, "main", None));
}

#[test]
fn tools_go_on_an_environment_path() {
    let plan = parse(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    tools: [builtin:gofmt@1.27, repo:lint@2]\n    run: gofmt -l .\n",
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        first(&plan).tools,
        vec![
            ToolRef::Builtin {
                name: "gofmt".into(),
                version: "1.27".into()
            },
            ToolRef::Repo {
                name: "lint".into(),
                version: "2".into()
            },
        ]
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: builtin:gofmt@1\n    tools: [builtin:oxfmt@1]\n",
        "needs `using: env:...`",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    tools: [env:bash-node@24]\n    run: x\n",
        "is an environment",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    tools: [builtin:gofmt@1, repo:gofmt@2]\n    run: x\n",
        "two tools named `gofmt`",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    tools: [gofmt]\n    run: x\n",
        "not a tool reference",
    );
}

#[test]
fn secrets_stay_names_and_only_live_in_env() {
    let plan = parse(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    env:\n      TOKEN: ${{ secrets.NPM_TOKEN }}\n      AUTH: \"Bearer ${{secrets.API_KEY}} on ${{ commit.branch }}\"\n      PLAIN: ${{ commit.branch }}\n    run: x\n",
        &ctx(),
    )
    .unwrap();
    let job = first(&plan);
    assert_eq!(job.env, vec![("PLAIN".to_string(), "main".to_string())]);
    assert_eq!(job.secret_env.len(), 2);
    assert_eq!(
        job.secret_env[0].parts,
        vec![SecretPart::Secret("NPM_TOKEN".into())]
    );
    assert_eq!(
        job.secret_env[1].parts,
        vec![
            SecretPart::Text("Bearer ".into()),
            SecretPart::Secret("API_KEY".into()),
            SecretPart::Text(" on main".into()),
        ]
    );
    let (value, missing) =
        job.secret_env[1].fill(|n| (n == "API_KEY").then(|| "s3cr3t".to_string()));
    assert_eq!(value, "Bearer s3cr3t on main");
    assert!(missing.is_empty());
    let (value, missing) = job.secret_env[0].fill(|_| None);
    assert_eq!(
        (value.as_str(), missing),
        ("", vec!["NPM_TOKEN".to_string()])
    );
    // The plan itself never holds a value.
    let json = serde_json::to_string(&plan).unwrap();
    assert!(!json.contains("s3cr3t"));

    for (field, yaml) in [
        (
            "args",
            "using: builtin:t@1\n    args: [\"${{ secrets.X }}\"]",
        ),
        ("run", "using: env:bash@5\n    run: echo ${{ secrets.X }}"),
        ("name", "using: builtin:t@1\n    name: ${{ secrets.X }}"),
    ] {
        let yaml = format!("name: x\njobs:\n  a:\n    {yaml}\n");
        assert_error(&yaml, "only be used in `env:` values");
        let _ = field;
    }
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    env: { T: \"${{ secrets.9bad }}\" }\n    run: x\n",
        "not a valid name",
    );
}

#[test]
fn vars_are_substituted_anywhere_and_unset_ones_are_empty() {
    let mut context = ctx();
    context.vars.insert("REGION".into(), "eu-west-1".into());
    let plan = parse(
        "name: x\njobs:\n  a:\n    name: deploy ${{ vars.REGION }}\n    using: builtin:t@1\n    args: [\"--region=${{ vars.REGION }}\", \"x${{ vars.UNSET }}\"]\n",
        &context,
    )
    .unwrap();
    let job = first(&plan);
    assert_eq!(job.display_name, "deploy eu-west-1");
    assert_eq!(
        job.action,
        Action::Args {
            args: vec!["--region=eu-west-1".into(), "x".into()]
        }
    );
}

#[test]
fn scratch_has_a_default_and_a_bound() {
    let plan = parse("name: x\njobs:\n  a:\n    using: builtin:t@1\n", &ctx()).unwrap();
    assert_eq!(plan.scratch_bytes, DEFAULT_SCRATCH);
    let plan = parse(
        "name: x\nscratch: 4GiB\njobs:\n  a:\n    using: builtin:t@1\n",
        &ctx(),
    )
    .unwrap();
    assert_eq!(plan.scratch_bytes, 4 << 30);
    assert_error(
        "name: x\nscratch: 64GiB\njobs:\n  a:\n    using: builtin:t@1\n",
        "between 16MiB and 16GiB",
    );
}

#[test]
fn artifacts_resolve_paths_per_matrix_entry() {
    let plan = parse(
        r#"
name: x
jobs:
  d:
    matrix: [web, ui]
    using: builtin:t@1
    artifacts: ["app/packages/${{ matrix }}/dist", /tmp/out]
"#,
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        plan.job("d[ui]").unwrap().artifacts,
        vec![
            "/app/app/packages/ui/dist".to_string(),
            "/tmp/out".to_string()
        ]
    );

    let job = |artifacts: &str| {
        format!("name: x\njobs:\n  t:\n    using: builtin:t@1\n    artifacts: {artifacts}\n")
    };
    assert_error(&job("[../x]"), "without `..`");
    assert_error(&job("[/iwci/output]"), "not a path a job can keep");
    assert_error(&job("[\"\"]"), "non-empty paths");
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    clone: false\n    artifacts: [dist]\n",
        "can only keep absolute paths",
    );
}

#[test]
fn jobs_reach_the_internet_unless_they_turn_it_off() {
    let plan = parse(
        "name: x\njobs:\n  online:\n    using: builtin:t@1\n  offline:\n    using: builtin:t@1\n    network: false\n",
        &ctx(),
    )
    .unwrap();
    assert!(plan.job("online").unwrap().network);
    assert!(!plan.job("offline").unwrap().network);
}

// `packages:` jobs.

fn workspace() -> Context {
    use std::collections::BTreeSet;
    let pkg = |dir: &str, name: &str, deps: &[&str], entries: &[&str], scripts: &[&str]| {
        workspace::Package {
            dir: dir.into(),
            name: name.into(),
            deps: deps.iter().map(|d| d.to_string()).collect(),
            entries: entries
                .iter()
                .map(|e| e.to_string())
                .collect::<BTreeSet<_>>(),
            scripts: scripts
                .iter()
                .map(|e| match e.split_once('=') {
                    Some((k, v)) => (k.to_string(), v.to_string()),
                    None => (e.to_string(), String::new()),
                })
                .collect(),
        }
    };
    // web -> ui -> types (no tsconfig) -> core
    let ws = workspace::WorkspacePackages {
        packages: vec![
            pkg(
                "apps/web",
                "web",
                &["libs/ui"],
                &["tsconfig.json"],
                &["typecheck=tsc --noEmit", "build=vite build"],
            ),
            pkg(
                "libs/core",
                "@x/core",
                &[],
                &["tsconfig.json"],
                &["build=tsdown"],
            ),
            pkg("libs/types", "@x/types", &["libs/core"], &[], &[]),
            pkg(
                "libs/ui",
                "@x/ui",
                &["libs/types", "libs/core"],
                &["tsconfig.json"],
                &["build=tsdown --dts"],
            ),
        ],
    };
    Context {
        packages: PackagesSource::Found(std::sync::Arc::new(ws)),
        ..ctx()
    }
}

fn template<'a>(plan: &'a Plan, key: &str) -> &'a JobTemplate {
    plan.template(key).unwrap_or_else(|| {
        panic!(
            "no `{key}` in {:?}",
            plan.jobs.iter().map(|t| &t.key).collect::<Vec<_>>()
        )
    })
}

#[test]
fn packages_jobs_follow_the_dependency_graph() {
    let plan = parse(
        r#"
name: ts
jobs:
  build:
    using: builtin:typescript@7.1
    packages: { has: [tsconfig.json], only: ["libs/*"] }
    needs: ["^build"]
    args: [-p, "${{ package.dir }}", --name, "${{ package.name }}"]
    artifacts: [dist]
    task-cache: { root-inputs: [tsconfig.base.json] }
  check:
    using: builtin:typescript@7.1
    packages: { has-script: [typecheck] }
    needs: ["^build"]
    args: [--noEmit]
  lint:
    using: builtin:typescript@7.1
    packages: true
    needs: [build]
    args: []
  report:
    using: builtin:typescript@7.1
    needs: [build, check]
    args: []
"#,
        &workspace(),
    )
    .unwrap();
    let keys: Vec<&str> = plan.jobs.iter().map(|t| t.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "build[libs/core]",
            "build[libs/ui]",
            "check[apps/web]",
            "lint[apps/web]",
            "lint[libs/core]",
            "lint[libs/types]",
            "lint[libs/ui]",
            "report"
        ]
    );
    assert!(template(&plan, "build[libs/core]").needs.is_empty());
    assert_eq!(
        template(&plan, "build[libs/ui]").needs,
        ["build[libs/core]"],
        "libs/types has no build, so ui waits for what types depends on"
    );
    assert_eq!(template(&plan, "check[apps/web]").needs, ["build[libs/ui]"]);
    assert_eq!(template(&plan, "lint[libs/ui]").needs, ["build[libs/ui]"]);
    assert!(
        template(&plan, "lint[apps/web]").needs.is_empty(),
        "web has no build of its own"
    );
    assert_eq!(
        template(&plan, "report").needs,
        ["build[libs/core]", "build[libs/ui]", "check[apps/web]"]
    );

    let ui = plan.job("build[libs/ui]").unwrap();
    assert_eq!(ui.display_name, "build (libs/ui)");
    assert_eq!(ui.cwd, "/app/libs/ui");
    assert_eq!(ui.artifacts, ["/app/libs/ui/dist"]);
    assert_eq!(
        ui.action,
        Action::Args {
            args: vec![
                "-p".into(),
                "libs/ui".into(),
                "--name".into(),
                "@x/ui".into()
            ]
        }
    );
    assert_eq!(ui.package.as_ref().map(|p| p.job.as_str()), Some("build"));
    assert_eq!(
        ui.task_cache.as_ref().unwrap().inputs,
        ["libs/ui/**", "tsconfig.base.json"]
    );
    assert!(plan.job("report").unwrap().task_cache.is_none());
}

#[test]
fn package_inputs_are_relative_to_the_package() {
    let plan = parse(
        r#"
name: ts
jobs:
  build:
    using: builtin:typescript@7.1
    packages: { only: ["@x/core"] }
    args: []
    task-cache: { inputs: ["src/**", "!src/**/*.test.ts"] }
  all:
    using: builtin:typescript@7.1
    args: []
    task-cache: true
"#,
        &workspace(),
    )
    .unwrap();
    assert_eq!(
        plan.job("build[libs/core]")
            .unwrap()
            .task_cache
            .as_ref()
            .unwrap()
            .inputs,
        ["libs/core/src/**", "!libs/core/src/**/*.test.ts"],
        "a name selects too, and exclusions keep their `!`"
    );
    assert_eq!(
        plan.job("all").unwrap().task_cache.as_ref().unwrap().inputs,
        ["**"]
    );
}

#[test]
fn packages_can_be_chosen_by_a_scripts_command() {
    let plan = parse(
        r#"
name: ts
jobs:
  lib:
    using: builtin:typescript@7.1
    packages: { scripts: { build: "tsdown*" } }
    args: []
  app:
    using: builtin:typescript@7.1
    packages: { scripts: { build: "!tsdown*" } }
    args: []
"#,
        &workspace(),
    )
    .unwrap();
    assert_eq!(
        ids(&plan),
        [
            "lib[libs/core]",
            "lib[libs/ui]",
            "app[apps/web]",
            "app[libs/types]"
        ]
    );
}

#[test]
fn packages_without_a_known_repository_use_a_placeholder() {
    let plan = parse(
        r#"
name: ts
jobs:
  build:
    using: builtin:typescript@7.1
    packages: { has: [tsconfig.json] }
    needs: ["^build"]
    args: ["${{ package.dir }}"]
"#,
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        ids(&plan),
        [format!("build[{}]", packages::PLACEHOLDER_DIR)]
    );
}

#[test]
fn packages_mistakes_are_named() {
    let with = |yaml: &str, needle: &str| {
        let errs = match parse(yaml, &workspace()) {
            Ok(_) => panic!("expected errors for {yaml}"),
            Err(e) => {
                e.0.into_iter()
                    .map(|e| format!("{}: {}", e.path, e.message))
                    .collect::<Vec<_>>()
            }
        };
        assert!(
            errs.iter().any(|e| e.contains(needle)),
            "no {needle:?} in {errs:#?}"
        );
    };
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], needs: ['^a'] }\n",
        "only means something in a job with `packages:`",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], packages: true, matrix: [1, 2] }\n",
        "cannot have a matrix",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], packages: true, outputs: [o] }\n",
        "cannot declare outputs",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], packages: true }\n  b: { using: builtin:t@1, args: [], needs: [a], if: \"needs.a.result == 'success'\" }\n",
        "has a result per package",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], packages: true, needs: ['^b'] }\n  b: { using: builtin:t@1, args: [] }\n",
        "needs a job with `packages:` named `b`",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: ['${{ package.dir }}'] }\n",
        "only exists in a job with `packages:`",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: ['${{ package.version }}'], packages: true }\n",
        "not `package.version`",
    );
    with(
        "name: x\njobs:\n  a: { using: env:bash@5, run: 'true', task-cache: true, env: { T: '${{ secrets.T }}' } }\n",
        "reads secrets cannot be task-cached",
    );
    with(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], task-cache: { inputs: ['../x'] } }\n",
        "inside the clone",
    );
    let missing = Context {
        packages: PackagesSource::Missing,
        ..ctx()
    };
    let errs = parse(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [], packages: true }\n",
        &missing,
    )
    .unwrap_err()
    .to_string();
    assert!(errs.contains("declares no workspace"), "{errs}");
}

#[test]
fn a_package_dependency_cycle_is_reported() {
    use std::collections::BTreeSet;
    let pkg = |dir: &str, deps: &[&str]| workspace::Package {
        dir: dir.into(),
        name: dir.into(),
        deps: deps.iter().map(|d| d.to_string()).collect(),
        entries: BTreeSet::new(),
        scripts: Default::default(),
    };
    let ctx = Context {
        packages: PackagesSource::Found(std::sync::Arc::new(workspace::WorkspacePackages {
            packages: vec![pkg("a", &["b"]), pkg("b", &["a"])],
        })),
        ..ctx()
    };
    let errs = parse(
        "name: x\njobs:\n  build: { using: builtin:t@1, args: [], packages: true, needs: ['^build'] }\n",
        &ctx,
    )
    .unwrap_err()
    .to_string();
    assert!(errs.contains("forms a cycle"), "{errs}");
}

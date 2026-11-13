use super::*;

fn ctx() -> Context {
    Context {
        commit_sha: "0123456789abcdef0123456789abcdef01234567".into(),
        branch: "main".into(),
        repo_id: "repo_1".into(),
        event: Event::Push,
        vars: Default::default(),
        packages: PackagesSource::Unknown,
        ..Default::default()
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
            only: None,
            file: None
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
        "name: x\nworkspace:\n  deps: [{ composer: { file: a.lock } }]\njobs:\n  t:\n    using: builtin:t@1\n",
        "file applies only to pip",
    );
    assert_error(
        "name: x\nworkspace:\n  deps: [{ pip: { file: ../../etc/passwd } }]\njobs:\n  t:\n    using: builtin:t@1\n",
        "inside the clone",
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
fn env_cache_turns_an_environments_caches_off() {
    let job = |extra: &str| {
        format!("name: x\njobs:\n  t:\n    using: env:go@1.27\n    run: go build\n{extra}")
    };
    let policy = |extra: &str| {
        first(&parse(&job(extra), &ctx()).unwrap())
            .env_cache
            .clone()
    };
    assert_eq!(policy(""), EnvCachePolicy::All);
    assert_eq!(policy("    env-cache: true\n"), EnvCachePolicy::All);
    assert_eq!(policy("    env-cache: false\n"), EnvCachePolicy::Off);
    let some = policy("    env-cache: { go-build: false, other: true }\n");
    assert_eq!(some, EnvCachePolicy::Except(vec!["go-build".into()]));
    assert!(!some.keeps("go-build") && some.keeps("other"));
    assert_error(&job("    env-cache: [go-build]\n"), "invalid type");
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
    let no_resource = |_: &str, _: &str| -> Result<String, String> { unreachable!() };
    let (value, missing) = job.secret_env[1]
        .fill(
            |n| (n == "API_KEY").then(|| "s3cr3t".to_string()),
            no_resource,
        )
        .unwrap();
    assert_eq!(value, "Bearer s3cr3t on main");
    assert!(missing.is_empty());
    let (value, missing) = job.secret_env[0].fill(|_| None, no_resource).unwrap();
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
fn downloads_take_a_list_or_options() {
    let plan = parse(
        r#"
name: x
jobs:
  plain:
    using: builtin:t@1
    downloads: [dist/app.tar.gz]
  report:
    matrix: [web, ui]
    using: builtin:t@1
    downloads:
      paths: ["reports/${{ matrix }}", /tmp/core]
      retention: 7d
      when: always
"#,
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        plan.job("plain").unwrap().downloads,
        Some(DownloadSpec {
            paths: vec!["/app/dist/app.tar.gz".into()],
            retention_secs: DEFAULT_DOWNLOAD_RETENTION_SECS,
            when: DownloadWhen::Success,
        })
    );
    assert_eq!(
        plan.job("report[ui]").unwrap().downloads,
        Some(DownloadSpec {
            paths: vec!["/app/reports/ui".into(), "/tmp/core".into()],
            retention_secs: 7 * 86_400,
            when: DownloadWhen::Always,
        })
    );
    assert_eq!(plan.job("plain").unwrap().artifacts, Vec::<String>::new());

    let job = |downloads: &str| {
        format!("name: x\njobs:\n  t:\n    using: builtin:t@1\n    downloads: {downloads}\n")
    };
    assert_error(&job("[../x]"), "without `..`");
    assert_error(&job("[/iwci/output]"), "not a path a job can download");
    assert_error(&job("[]"), "needs 1 to 64 non-empty paths");
    assert_error(
        &job("{ paths: [a], retention: 30m }"),
        "between 1h and 365d",
    );
    assert_error(
        &job("{ paths: [a], retention: 400d }"),
        "between 1h and 365d",
    );
    assert_error(&job("{ paths: [a], retention: soon }"), "not a duration");
    assert_error(
        &job("{ paths: [a], when: sometimes }"),
        "`success`, `failure` or `always`",
    );
    assert_error(&job("{ paths: [a], zzz: 1 }"), "unknown field `zzz`");
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    clone: false\n    downloads: [dist]\n",
        "can only keep absolute paths",
    );
    assert_error(
        "name: x\njobs:\n  t:\n    using: builtin:t@1\n    task-cache: true\n    downloads: [dist]\n",
        "cannot be task-cached",
    );
    assert!(DownloadWhen::Failure.keeps(false) && !DownloadWhen::Failure.keeps(true));
    assert!(DownloadWhen::Always.keeps(true) && DownloadWhen::Always.keeps(false));
    assert!(DownloadWhen::Success.keeps(true) && !DownloadWhen::Success.keeps(false));
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
fn a_packages_job_can_have_a_matrix() {
    let plan = parse(
        r#"
name: ts
jobs:
  build:
    using: builtin:typescript@7.1
    packages: { has: [tsconfig.json], only: ["libs/*"] }
    needs: ["^build"]
    args: []
    artifacts: [dist]
    task-cache: { artifacts: false }
  test:
    name: test ${{ package.name }} ${{ matrix }}/2
    using: builtin:typescript@7.1
    packages: { only: [apps/web, libs/ui] }
    matrix: [1, 2]
    needs: [build, "^build"]
    args: ["--shard=${{ matrix }}/2"]
    task-cache: true
  unnamed:
    using: builtin:typescript@7.1
    packages: { only: [libs/core] }
    matrix: { mode: [a] }
    args: []
  report:
    using: builtin:typescript@7.1
    needs: [test]
    args: []
"#,
        &workspace(),
    )
    .unwrap();
    assert_eq!(
        ids(&plan),
        [
            "build[libs/core]",
            "build[libs/ui]",
            "test[apps/web][1]",
            "test[apps/web][2]",
            "test[libs/ui][1]",
            "test[libs/ui][2]",
            "unnamed[libs/core][a]",
            "report",
        ]
    );
    // Each package's job is one key whose entries share its needs.
    assert_eq!(template(&plan, "test[apps/web]").needs, ["build[libs/ui]"]);
    assert_eq!(
        template(&plan, "test[libs/ui]").needs,
        ["build[libs/ui]", "build[libs/core]"]
    );
    assert_eq!(
        template(&plan, "report").needs,
        ["test[apps/web]", "test[libs/ui]"]
    );
    let second = plan.job("test[libs/ui][2]").unwrap();
    assert_eq!(second.display_name, "test @x/ui 2/2");
    assert_eq!(second.cwd, "/app/libs/ui");
    assert_eq!(
        second.action,
        Action::Args {
            args: vec!["--shard=2/2".into()]
        }
    );
    assert_eq!(
        second.task_cache.as_ref().unwrap().inputs,
        ["libs/ui/**"],
        "every entry reads its package"
    );
    assert!(second.task_cache.as_ref().unwrap().artifacts);
    assert_eq!(
        plan.job("unnamed[libs/core][a]").unwrap().display_name,
        "unnamed (libs/core, a)"
    );
    assert!(
        !plan
            .job("build[libs/ui]")
            .unwrap()
            .task_cache
            .as_ref()
            .unwrap()
            .artifacts,
        "`artifacts: false` leaves what it is handed out of its key"
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

#[test]
fn services_are_planned_with_their_readiness_and_secrets_as_names() {
    let plan = parse(
        r#"name: x
jobs:
  test:
    using: env:python@3.13
    matrix: [a, b]
    run: pytest
    services:
      postgres:
        using: env:postgres@18
        run: pglite
        env:
          PASSWORD: ${{ secrets.DB_PASSWORD }}
          MODE: ${{ matrix }}
        ready: { log: "SOCKET_READY [0-9]+", timeout: 2m }
      api:
        using: env:bash-node@24
        run: node server.js ${{ matrix }}
        ready: { port: 3000 }
      probe:
        using: env:bash@5
        run: ./serve.sh
        ready: { command: "test -e /tmp/up" }
      tool:
        using: builtin:server@1
        args: "--port 9000 --name 'a b'"
"#,
        &ctx(),
    )
    .unwrap();
    let job = plan.job("test[b]").unwrap();
    let names: Vec<_> = job.services.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["postgres", "api", "probe", "tool"]);
    let pg = &job.services[0];
    assert_eq!(
        pg.tool,
        ToolRef::Env {
            name: "postgres".into(),
            version: "18".into()
        }
    );
    assert_eq!(
        pg.action,
        Action::Script {
            script: "pglite".into()
        }
    );
    assert_eq!(pg.env, vec![("MODE".to_string(), "b".to_string())]);
    assert_eq!(pg.secret_env.len(), 1);
    assert_eq!(
        pg.secret_env[0].parts,
        vec![SecretPart::Secret("DB_PASSWORD".into())]
    );
    assert_eq!(
        pg.ready,
        Readiness {
            check: ReadyCheck::Log {
                pattern: "SOCKET_READY [0-9]+".into()
            },
            timeout: std::time::Duration::from_secs(120),
        }
    );
    // A secret never reaches the plan as it is reported.
    let json = serde_json::to_string(&plan.job("test[a]").unwrap()).unwrap();
    assert!(
        json.contains("DB_PASSWORD") && json.contains("\"services\""),
        "{json}"
    );

    assert_eq!(
        job.services[1].action,
        Action::Script {
            script: "node server.js b".into()
        }
    );
    assert_eq!(job.services[1].ready.check, ReadyCheck::Port { port: 3000 });
    assert_eq!(
        job.services[1].ready.timeout.as_secs(),
        DEFAULT_READY_TIMEOUT_SECS
    );
    assert_eq!(
        job.services[2].ready.check,
        ReadyCheck::Command {
            script: "test -e /tmp/up".into()
        }
    );
    assert_eq!(
        job.services[3].action,
        Action::Args {
            args: vec![
                "--port".into(),
                "9000".into(),
                "--name".into(),
                "a b".into()
            ]
        }
    );
    assert_eq!(job.services[3].ready.check, ReadyCheck::Started);
}

#[test]
fn workspace_services_reach_every_job_unless_it_says_otherwise() {
    let plan = parse(
        r#"name: x
workspace:
  services:
    db: { using: env:postgres@18, run: pglite, ready: { port: 5432 } }
    cache: { using: env:bash@5, run: ./cache.sh }
jobs:
  plain: { using: env:bash@5, run: "true" }
  own:
    using: env:bash@5
    run: "true"
    services:
      db: { using: env:postgres@18, run: "pglite --x", ready: { port: 5433 } }
      extra: { using: builtin:x@1 }
  none: { using: builtin:t@1, services: false }
  kept: { using: builtin:t@1, services: true }
"#,
        &ctx(),
    )
    .unwrap();
    let names = |id: &str| -> Vec<String> {
        plan.job(id)
            .unwrap()
            .services
            .iter()
            .map(|s| s.name.clone())
            .collect()
    };
    assert_eq!(names("plain"), ["db", "cache"]);
    // The job's own `db` takes the workspace's place; its others follow.
    assert_eq!(names("own"), ["db", "cache", "extra"]);
    assert_eq!(
        plan.job("own").unwrap().services[0].ready.check,
        ReadyCheck::Port { port: 5433 }
    );
    assert!(names("none").is_empty());
    assert_eq!(names("kept"), ["db", "cache"]);
    // A job without services serialises as it did before they existed.
    let json = serde_json::to_string(plan.job("none").unwrap()).unwrap();
    assert!(!json.contains("services"), "{json}");
}

#[test]
fn bad_services_are_reported() {
    let job = |services: &str| {
        format!(
            "name: x\njobs:\n  a:\n    using: env:bash@5\n    run: x\n    services:\n{services}"
        )
    };
    for (services, needle) in [
        (
            "      Db: { using: env:bash@5, run: x }\n",
            "service names use",
        ),
        (
            "      localhost: { using: env:bash@5, run: x }\n",
            "already names",
        ),
        (
            "      db: { using: postgres, run: x }\n",
            "is not a tool reference",
        ),
        (
            "      db: { using: env:postgres@18 }\n",
            "give the service a `run:`",
        ),
        (
            "      db: { using: env:postgres@18, run: x, args: [a] }\n",
            "takes a `run:` script, not `args:`",
        ),
        (
            "      db: { using: builtin:x@1, run: x }\n",
            "is a tool; give it `args:`",
        ),
        (
            "      db: { using: env:bash@5, run: x, env: { IWCI_X: y } }\n",
            "set by the runner",
        ),
        (
            "      db: { using: env:bash@5, run: x, ready: { port: 1, log: x } }\n",
            "give one of `port`, `log` or `command`",
        ),
        (
            "      db: { using: env:bash@5, run: x, ready: { port: 0 } }\n",
            "between 1 and 65535",
        ),
        (
            "      db: { using: env:bash@5, run: x, ready: { log: '(' } }\n",
            "is not a regular expression",
        ),
        (
            "      db: { using: builtin:x@1, ready: { command: 'true' } }\n",
            "needs `using: env:...`",
        ),
        (
            "      db: { using: env:bash@5, run: x, ready: { port: 1, timeout: 2h } }\n",
            "no longer than the job's timeout",
        ),
        (
            "      db: { using: env:bash@5, run: x, ready: { port: 1, timeout: soon } }\n",
            "is not a duration",
        ),
        (
            "      db: { using: env:bash@5, run: 'echo ${{ secrets.X }}' }\n",
            "secrets can only be used in `env:` values",
        ),
        (
            "      db: { using: env:bash@5, run: x, zzz: 1 }\n",
            "unknown field `zzz`",
        ),
        (
            "      db: { using: env:bash@5, run: x, ready: { zzz: 1 } }\n",
            "unknown field `zzz`",
        ),
    ] {
        assert_error(&job(services), needle);
    }
    let many: String = (0..=MAX_SERVICES)
        .map(|i| format!("      s{i}: {{ using: builtin:x@1 }}\n"))
        .collect();
    assert_error(&job(&many), "the limit is 8");
    // A service's secret could change what a job does, as the job's own can.
    assert_error(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    run: 'true'\n    task-cache: true\n    services:\n      db: { using: env:bash@5, run: x, env: { T: '${{ secrets.T }}' } }\n",
        "services read secrets cannot be task-cached",
    );
}

#[test]
fn concurrency_is_a_group_or_a_group_and_cancel_in_progress() {
    let plan = parse(
        "name: Test\nconcurrency: ${{ pipeline.name }}-${{ commit.branch }}\njobs:\n  a: { using: builtin:t@1, args: [] }\n",
        &ctx(),
    )
    .unwrap();
    assert_eq!(
        plan.concurrency,
        Some(Concurrency {
            group: "Test-main".into(),
            cancel_in_progress: false,
        })
    );
    let pr = Context {
        event: Event::PullRequest,
        branch: "pull/12".into(),
        pull_request: Some(12),
        vars: [("ENV".to_string(), "prod".to_string())].into(),
        ..ctx()
    };
    let plan = parse(
        "name: Deploy\nconcurrency:\n  group: deploy-${{ vars.ENV }}-pr-${{ pull-request.number }}\n  cancel-in-progress: true\njobs:\n  a: { using: builtin:t@1, args: [] }\n",
        &pr,
    )
    .unwrap();
    assert_eq!(
        plan.concurrency,
        Some(Concurrency {
            group: "deploy-prod-pr-12".into(),
            cancel_in_progress: true,
        })
    );
    // A push has no pull request number.
    let plan = parse(
        "name: x\nconcurrency: { group: 'pr-${{ pull-request.number }}x' }\njobs:\n  a: { using: builtin:t@1, args: [] }\n",
        &Context {
            pull_request: Some(3),
            ..ctx()
        },
    )
    .unwrap();
    assert_eq!(plan.concurrency.unwrap().group, "pr-x");
    // Without one, none.
    let plan = parse(
        "name: x\njobs:\n  a: { using: builtin:t@1, args: [] }\n",
        &ctx(),
    )
    .unwrap();
    assert!(plan.concurrency.is_none());
}

#[test]
fn pipeline_name_and_pull_request_number_work_in_any_value() {
    let plan = parse(
        "name: Lint\njobs:\n  a: { using: builtin:t@1, args: ['${{ pipeline.name }}', '${{ pull-request.number }}'], if: \"pipeline.name == 'Lint'\" }\n",
        &Context {
            event: Event::PullRequest,
            pull_request: Some(7),
            ..ctx()
        },
    )
    .unwrap();
    match &first(&plan).action {
        Action::Args { args } => assert_eq!(args, &vec!["Lint".to_string(), "7".to_string()]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_concurrency_group_must_be_known_before_the_run() {
    for (yaml, needle) in [
        (
            "concurrency: g-${{ matrix }}",
            "not known before the run starts",
        ),
        (
            "concurrency: { group: 'g-${{ needs.a.outputs.x }}' }",
            "not known before the run starts",
        ),
        (
            "concurrency: '${{ hashFiles(\"a\") }}'",
            "not known before the run starts",
        ),
        (
            "concurrency: '${{ secrets.T }}'",
            "secrets can only be used",
        ),
        ("concurrency: '${{ nope }}'", "unknown expression"),
        (
            "concurrency: \"${{ vars.EMPTY }}\"",
            "empty once substituted",
        ),
        (
            "concurrency: { group: g, zzz: true }",
            "unknown field `zzz`",
        ),
        (
            "concurrency: { cancel-in-progress: true }",
            "missing field `group`",
        ),
        ("concurrency: [a]", "a group name or"),
    ] {
        let full = format!("name: x\n{yaml}\njobs:\n  a: {{ using: builtin:t@1, args: [] }}\n");
        let errs = match parse(&full, &ctx()) {
            Ok(_) => panic!("{yaml}: expected an error"),
            Err(e) => e.to_string(),
        };
        assert!(errs.contains(needle), "{yaml}: {errs}");
    }
    let long = format!(
        "name: x\nconcurrency: {}\njobs:\n  a: {{ using: builtin:t@1, args: [] }}\n",
        "g".repeat(MAX_CONCURRENCY_GROUP + 1)
    );
    assert!(
        parse(&long, &ctx())
            .unwrap_err()
            .to_string()
            .contains("over 256 characters")
    );
}

#[test]
fn a_pull_request_number_comes_from_its_ref_or_branch() {
    assert_eq!(
        pull_request_number(Some("refs/pull/42/head"), "x"),
        Some(42)
    );
    assert_eq!(
        pull_request_number(Some("refs/heads/main"), "pull/7"),
        Some(7)
    );
    assert_eq!(pull_request_number(None, "main"), None);
    assert_eq!(pull_request_number(None, "pull/x"), None);
}

#[test]
fn a_cloud_job_keeps_its_place_in_the_graph_and_takes_nothing_of_the_runner() {
    let plan = parse(
        r#"
name: x
workspace:
  deps: [pnpm]
  services:
    db: { using: env:postgres@18, run: pglite-server }
jobs:
  build:
    using: env:bash@5
    run: make
    outputs: [tag]
  image:
    cloud: gcp/build
    needs: [build]
    run: docker build -t app:${{ needs.build.outputs.tag }} .
    timeout: 30m
    outputs: [digest]
    artifacts: [out/sbom.json]
    clone: { depth: 5 }
    changes: fail
  push:
    matrix: { size: [small, large] }
    cloud:
      provider: aws
      kind: vm
      connection: Production
      machine: m7i.${{ matrix.size }}
      image: ubuntu-24.04
      region: eu-west-1
      gpu: a100:2
    run: ./deploy.sh
"#,
        &ctx(),
    )
    .unwrap();
    let image = plan.template("image").unwrap();
    assert_eq!(
        image.tool,
        ToolRef::Cloud {
            provider: "gcp".into(),
            kind: "build".into()
        }
    );
    assert_eq!(image.tool.to_string(), "cloud:gcp/build");
    assert_eq!(image.cloud.as_ref().unwrap().kind, "build");
    // Deferred (it reads an output), and its workspace installs nothing and
    // starts no services.
    assert!(image.instances.is_none());
    let ws = &plan.workspaces[image.workspace];
    assert!(ws.deps.is_empty());
    assert_eq!(ws.clone.as_ref().unwrap().depth, CloneDepth::Shallow(5));
    let mut needs = NeedsValues::default();
    needs.results.insert("build".into(), JobResult::Success);
    needs
        .outputs
        .insert("build".into(), [("tag".into(), "v1".into())].into());
    let jobs = plan.instantiate("image", &needs).unwrap();
    let job = &jobs[0];
    assert_eq!(job.memory_bytes, 0);
    assert!(job.services.is_empty());
    assert_eq!(job.artifacts, ["/app/out/sbom.json"]);
    assert_eq!(job.changes, ChangePolicy::Fail);
    assert_eq!(
        job.action,
        Action::Script {
            script: "docker build -t app:v1 .".into()
        }
    );
    let push = plan.template("push").unwrap().instances.as_ref().unwrap();
    let small = push[0].cloud.as_ref().unwrap();
    assert_eq!(small.machine.as_deref(), Some("m7i.small"));
    assert_eq!(small.connection.as_deref(), Some("Production"));
    assert_eq!(small.gpu.as_deref(), Some("a100:2"));
    assert_eq!(
        push[1].cloud.as_ref().unwrap().machine.as_deref(),
        Some("m7i.large")
    );
    // The template keeps what was written, for the app to read before the
    // run starts.
    assert_eq!(
        plan.template("push")
            .unwrap()
            .cloud
            .as_ref()
            .unwrap()
            .machine
            .as_deref(),
        Some("m7i.${{ matrix.size }}")
    );
}

#[test]
fn a_cloud_job_refuses_what_only_means_something_on_the_runner() {
    let base = "name: x\njobs:\n  a:\n    cloud: aws/vm\n    run: x\n";
    for (extra, needle) in [
        (
            "    using: env:bash@5\n",
            "jobs.a.using: a cloud job runs in its machine's image",
        ),
        (
            "    deps: [pnpm]\n",
            "jobs.a.deps: installs dependencies on the runner",
        ),
        (
            "    tools: [builtin:gofmt@1]\n",
            "jobs.a.tools: puts runner tools on PATH",
        ),
        (
            "    cache: { key: k, paths: [x] }\n",
            "jobs.a.cache: keeps files in the runner's cache",
        ),
        (
            "    memory: 4GiB\n",
            "jobs.a.memory: sizes a job on the runner",
        ),
        (
            "    network: false\n",
            "jobs.a.network: keeps a job off the internet",
        ),
        (
            "    services:\n      db: { using: env:postgres@18, run: x }\n",
            "jobs.a.services: starts services beside the job",
        ),
        (
            "    clone: false\n",
            "jobs.a.clone: a cloud job always starts from the commit",
        ),
        (
            "    clone: { into: /src }\n",
            "jobs.a.clone: a cloud job takes only",
        ),
        (
            "    downloads: [x]\n",
            "jobs.a.downloads: keeps files for people to download",
        ),
        (
            "    changes: { commit: msg }\n",
            "jobs.a.changes: commits its changes",
        ),
        (
            "    task-cache: true\n",
            "jobs.a.task-cache: replays a run from the task cache",
        ),
        ("    env-cache: false\n", "jobs.a.env-cache"),
        (
            "    args: [x]\n",
            "jobs.a.args: a cloud job takes a `run:` script",
        ),
        ("    packages: true\n", "packages"),
    ] {
        assert_error(&format!("{base}{extra}"), needle);
    }
    assert_error(
        "name: x\njobs:\n  a:\n    cloud: aws/vm\n",
        "a cloud job needs a `run:` script",
    );
    assert_error(
        "name: x\njobs:\n  a:\n    run: x\n",
        "needs `using:` (a tool or environment), or `cloud:`",
    );
    assert_error(
        "name: x\njobs:\n  a: { cloud: aws, run: x }\n",
        "is `<provider>/<kind>`",
    );
    assert_error(
        "name: x\njobs:\n  a: { cloud: aws/laptop, run: x }\n",
        "jobs.a.cloud.kind: is one of `vm`, `container`, `build`, `host`, `cluster`, not `laptop`",
    );
    assert_error(
        "name: x\njobs:\n  a: { cloud: { kind: vm }, run: x }\n",
        "jobs.a.cloud.provider: is required",
    );
    assert_error(
        "name: x\njobs:\n  a: { cloud: \"${{ vars.P }}/vm\", run: x }\n",
        "is not a provider id",
    );
    assert_error(
        "name: x\njobs:\n  a: { cloud: { provider: gcp, kind: vm, gpu: \"a100:0\" }, run: x }\n",
        "jobs.a.cloud.gpu",
    );
    assert_error(
        "name: x\njobs:\n  a: { cloud: { provider: gcp, kind: vm, size: big }, run: x }\n",
        "unknown field `size`",
    );
    // A workspace's services and dependencies are simply not a cloud
    // job's, rather than an error in every pipeline that has both.
    parse(
        "name: x\nworkspace:\n  deps: [go]\n  services:\n    db: { using: env:postgres@18, run: x }\njobs:\n  a: { cloud: aws/vm, run: x, services: false, env: { A: b } }\n",
        &ctx(),
    )
    .unwrap();
}

#[test]
fn connections_keys_and_resources_are_listed_for_the_app_and_never_substituted() {
    let plan = parse(
        r#"
name: x
jobs:
  deploy:
    using: env:bash-node@24
    connections:
      - Production cluster
      - { name: staging, namespace: web }
    ssh-keys: [deploy]
    env-from: [r2-assets]
    env:
      DATABASE_URL: ${{ resources.prod-db.connectionString }}
      DSN: "postgres://${{ resources.prod-db.user }}@${{ resources.prod-db.host }}/app"
      API_KEY: ${{ resources.stripe-key.value }}
    services:
      cache:
        using: env:bash@5
        run: x
        env: { TOKEN: "${{ resources.cache-token.value }}" }
    run: kubectl rollout restart deploy/web
"#,
        &ctx(),
    )
    .unwrap();
    let job = first(&plan);
    let access = &plan.template("deploy").unwrap().access;
    assert_eq!(&job.access, access);
    assert_eq!(
        access.connections,
        [
            ConnectionUse {
                name: "Production cluster".into(),
                namespace: None
            },
            ConnectionUse {
                name: "staging".into(),
                namespace: Some("web".into())
            }
        ]
    );
    assert_eq!(access.ssh_keys, ["deploy"]);
    assert_eq!(access.env_from, ["r2-assets"]);
    let outputs =
        |name: &str| -> Vec<&str> { access.resources[name].iter().map(String::as_str).collect() };
    assert_eq!(outputs("prod-db"), ["connectionString", "host", "user"]);
    assert_eq!(outputs("stripe-key"), ["value"]);
    assert_eq!(outputs("cache-token"), ["value"]);
    let dsn = job.secret_env.iter().find(|e| e.key == "DSN").unwrap();
    assert_eq!(
        dsn.parts[1],
        SecretPart::Resource {
            name: "prod-db".into(),
            output: "user".into()
        }
    );
    let (value, _) = dsn
        .fill(|_| None, |name, output| Ok(format!("<{name}.{output}>")))
        .unwrap();
    assert_eq!(value, "postgres://<prod-db.user>@<prod-db.host>/app");
    assert_eq!(
        dsn.fill(|_| None, |name, _| Err(format!("{name} is not granted")))
            .unwrap_err(),
        "prod-db is not granted"
    );
    assert!(job.env.iter().all(|(k, _)| k != "DATABASE_URL"));
    let json = serde_json::to_string(&plan).unwrap();
    assert!(json.contains("\"connectionString\""));
}

#[test]
fn lent_names_are_checked_where_they_are_written() {
    for (yaml, needle) in [
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, connections: [a, a] }\n",
            "jobs.a.connections: lists `a` twice",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, connections: [\"${{ vars.C }}\"] }\n",
            "names are literal",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, connections: [\" padded\"] }\n",
            "no leading or trailing spaces",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, connections: [{ name: k, namespace: Web }] }\n",
            "is not a Kubernetes namespace",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, ssh-keys: [\"\"] }\n",
            "jobs.a.ssh-keys",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, env-from: [\"r2 assets\"] }\n",
            "is not a resource name",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: \"echo ${{ resources.db.url }}\" }\n",
            "resources can only be read in `env:` values",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, env: { A: \"${{ resources.db }}\" } }\n",
            "names no output",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, env: { A: \"${{ resources.-db.url }}\" } }\n",
            "is not a resource name",
        ),
        (
            "name: x\nconcurrency: \"g-${{ resources.db.url }}\"\njobs:\n  a: { using: env:bash@5, run: x }\n",
            "resources can only be read",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, ssh-keys: [k], task-cache: true }\n",
            "a job that is lent connections, SSH keys or resources cannot be task-cached",
        ),
        (
            "name: x\njobs:\n  a: { using: env:bash@5, run: x, env: { A: \"${{ resources.db.url }}\" }, task-cache: true }\n",
            "a job that reads secrets cannot be task-cached",
        ),
    ] {
        assert_error(yaml, needle);
    }
    let many: Vec<String> = (0..=MAX_LENT).map(|i| format!("k{i}")).collect();
    assert_error(
        &format!(
            "name: x\njobs:\n  a: {{ using: env:bash@5, run: x, ssh-keys: [{}] }}\n",
            many.join(", ")
        ),
        "the limit is 16",
    );
}

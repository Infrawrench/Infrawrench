//! `platform:` and `shell:`: jobs in a virtual machine.

use super::*;

fn ctx() -> Context {
    Context {
        commit_sha: "0123456789abcdef0123456789abcdef01234567".into(),
        branch: "main".into(),
        repo_id: "repo_1".into(),
        event: Event::Push,
        packages: PackagesSource::Unknown,
        ..Default::default()
    }
}

fn first(plan: &Plan) -> &PlannedJob {
    plan.static_jobs().next().unwrap()
}

fn assert_error(yaml: &str, needle: &str) {
    let errs: Vec<String> = match parse(yaml, &ctx()) {
        Ok(_) => panic!("expected errors for {yaml}"),
        Err(e) => {
            e.0.into_iter()
                .map(|e| format!("{}: {}", e.path, e.message))
                .collect()
        }
    };
    assert!(
        errs.iter().any(|e| e.contains(needle)),
        "no error containing {needle:?} in {errs:#?}"
    );
}

#[test]
fn platform_defaults_to_wasm() {
    let plan = parse(
        "name: t\njobs:\n  a:\n    using: env:bash@5\n    run: 'true'\n  b:\n    platform: wasm\n    using: env:bash@5\n    run: 'true'\n",
        &ctx(),
    )
    .unwrap();
    for job in plan.static_jobs() {
        assert_eq!(job.vm, None, "{}", job.id);
        assert!(!job.tool.is_vm());
    }
    assert!(plan.jobs.iter().all(|t| t.vm.is_none()));
}

#[test]
fn a_linux_job_runs_its_script_in_the_default_image() {
    let plan = parse(
        "name: t
workspace:
  deps: [pnpm]
  services:
    db: { using: 'env:postgres@17', args: [] }
jobs:
  build:
    platform: linux
    run: make
    artifacts: [out]
    downloads: [out/app.tar.gz]
    cache: { key: k, paths: [/root/.cache] }
    changes: fail
    network: false
",
        &ctx(),
    )
    .unwrap();
    let job = first(&plan);
    assert_eq!(
        job.vm,
        Some(VmSpec {
            os: VmOs::Linux,
            image: "ubuntu-24.04".into(),
            shell: "bash".into(),
        })
    );
    assert_eq!(
        job.tool,
        ToolRef::Vm {
            os: VmOs::Linux,
            image: "ubuntu-24.04".into()
        }
    );
    assert_eq!(job.tool.to_string(), "vm:linux/ubuntu-24.04");
    assert_eq!(
        job.action,
        Action::Script {
            script: "make".into()
        }
    );
    assert_eq!(job.memory_bytes, 2 << 30);
    // The workspace's deps and services are the isolates', not the
    // machine's; the clone is the machine's too.
    assert!(job.services.is_empty());
    assert!(plan.workspaces[job.workspace].deps.is_empty());
    assert!(plan.workspaces[job.workspace].clone.is_some());
    assert_eq!(job.artifacts, ["/app/out"]);
    assert!(!job.network);
    assert_eq!(plan.jobs[0].vm.as_ref().map(|v| v.os), Some(VmOs::Linux));
}

#[test]
fn windows_machines_are_turned_off() {
    let job = |body: &str| format!("name: t\njobs:\n  a:\n{body}");
    assert_error(
        &job("    platform: windows\n    run: dir\n"),
        "jobs.a.platform: `windows` machines are not available yet; use `linux`",
    );
    assert_error(
        &job("    platform: { os: windows, image: windows-11-arm }\n    run: dir\n"),
        "jobs.a.platform.os: `windows` machines are not available yet",
    );
}

#[test]
fn platform_errors() {
    let job = |body: &str| format!("name: t\njobs:\n  a:\n{body}");
    assert_error(
        &job("    platform: macos\n    run: x\n"),
        "jobs.a.platform: is `wasm` or `linux`, written out, not `macos`",
    );
    assert_error(
        &job("    platform: { os: bsd }\n    run: x\n"),
        "jobs.a.platform.os: is `wasm` or `linux`, written out, not `bsd`",
    );
    assert_error(
        &job("    platform: { os: linux, image: debian-13 }\n    run: x\n"),
        "jobs.a.platform.image: `debian-13` is not a linux image; use `ubuntu-24.04`",
    );
    assert_error(
        &job("    platform: { os: linux, size: big }\n    run: x\n"),
        "unknown field `size`",
    );
    assert_error(&job("    platform: [linux]\n    run: x\n"), "`platform` is");
    assert_error(
        &job("    platform: linux\n    shell: cmd\n    run: x\n"),
        "jobs.a.shell: `cmd` is not a linux shell; use `bash`, `sh` or `pwsh`",
    );
    assert_error(
        &job("    using: env:bash@5\n    shell: bash\n    run: x\n"),
        "jobs.a.shell: is for a `platform: linux` job",
    );
    assert_error(
        &job("    platform: linux\n    using: env:bash@5\n    run: x\n"),
        "jobs.a.using: a job on a virtual machine runs in the machine's image",
    );
    assert_error(
        &job("    platform: linux\n    cloud: gcp/vm\n    run: x\n"),
        "jobs.a.platform: `platform:` and `cloud:` both say where the job runs",
    );
    assert_error(
        &job("    platform: linux\n    args: [x]\n"),
        "jobs.a.args: a job on a virtual machine takes a `run:` script",
    );
    assert_error(
        &job("    platform: linux\n"),
        "jobs.a: a job on a virtual machine needs a `run:` script",
    );
    assert_error(
        &job("    platform: { os: wasm, image: x }\n    using: env:bash@5\n    run: x\n"),
        "jobs.a.platform.image: a `wasm` job runs in an isolate",
    );
    assert_error(
        &job("    platform: linux\n    memory: 64MiB\n    run: x\n"),
        "jobs.a.memory: must be between 256MiB and 16GiB",
    );
}

#[test]
fn what_a_virtual_machine_cannot_have() {
    let job = |body: &str| format!("name: t\njobs:\n  a:\n    platform: linux\n    run: x\n{body}");
    assert_error(
        &job("    deps: [pnpm]\n"),
        "jobs.a.deps: installs dependencies",
    );
    assert_error(
        &job("    tools: ['builtin:gh@2.104']\n"),
        "jobs.a.tools: puts the runner's tools",
    );
    assert_error(
        &job("    services:\n      db: { using: 'env:postgres@17', args: [] }\n"),
        "jobs.a.services: starts services in the job's isolate",
    );
    assert_error(&job("    env-cache: false\n"), "jobs.a.env-cache:");
    assert_error(&job("    task-cache: true\n"), "jobs.a.task-cache:");

    // A Linux machine is lent what any job is.
    let plan = parse(
        &job(
            "    connections: [prod]\n    ssh-keys: [deploy]\n    github-token: { contents: read }\n",
        ),
        &ctx(),
    )
    .unwrap();
    assert_eq!(first(&plan).access.ssh_keys, ["deploy"]);
}

#[test]
fn a_matrix_job_on_a_machine_expands_like_any_other() {
    let plan = parse(
        "name: t\njobs:\n  test:\n    platform: linux\n    matrix: [1, 2]\n    run: make test SHARD=${{ matrix }}\n",
        &ctx(),
    )
    .unwrap();
    let ids: Vec<&str> = plan.static_jobs().map(|j| j.id.as_str()).collect();
    assert_eq!(ids, ["test[1]", "test[2]"]);
    assert_eq!(
        plan.static_jobs().nth(1).unwrap().action,
        Action::Script {
            script: "make test SHARD=2".into()
        }
    );
    assert!(plan.static_jobs().all(|j| j.vm.is_some()));
}

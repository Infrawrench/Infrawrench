use super::*;
use iwci_vfs::SnapshotBuilder;

/// A tree from `(path, contents)` files and `(link, target)` symlinks.
fn tree(files: &[(&str, &str)], links: &[(&str, &str)]) -> SnapshotBuilder {
    let b = SnapshotBuilder::new();
    for (path, contents) in files {
        b.write(path, contents.as_bytes()).unwrap();
    }
    for (link, target) in links {
        b.symlink(link, target).unwrap();
    }
    b
}

fn pkg(name: &str, version: &str, extra: &str) -> String {
    format!(r#"{{"name":"{name}","version":"{version}"{extra}}}"#)
}

fn names(p: &Plan) -> Vec<String> {
    p.steps
        .iter()
        .map(|s| {
            let events: Vec<&str> = s.events.iter().map(|e| e.name.as_str()).collect();
            format!("{}:{}", s.name, events.join(","))
        })
        .collect()
}

/// npm's nested layout: `b` depends on `a` and builds with node-gyp, `c`
/// has nothing to run, `d` nests its own `a`.
fn npm_tree(root_extra: &str, npmrc: Option<&str>) -> SnapshotBuilder {
    let mut files = vec![
        (
            "/app/package.json".to_string(),
            pkg(
                "app",
                "1.0.0",
                &format!(
                    r#","scripts":{{"postinstall":"node setup.js","prepare":"husky","test":"x"}}{root_extra}"#
                ),
            ),
        ),
        (
            "/app/node_modules/b/package.json".into(),
            pkg("b", "1.0.0", r#","dependencies":{"a":"^1"}"#),
        ),
        ("/app/node_modules/b/binding.gyp".into(), "{}".into()),
        (
            "/app/node_modules/a/package.json".into(),
            pkg("a", "1.2.0", r#","scripts":{"postinstall":"node a.js"}"#),
        ),
        (
            "/app/node_modules/c/package.json".into(),
            pkg("c", "1.0.0", r#","dependencies":{"b":"1"}"#),
        ),
        (
            "/app/node_modules/d/package.json".into(),
            pkg(
                "d",
                "1.0.0",
                r#","dependencies":{"a":"2"},"scripts":{"install":"make"}"#,
            ),
        ),
        (
            "/app/node_modules/d/node_modules/a/package.json".into(),
            pkg("a", "2.0.0", r#","scripts":{"preinstall":"echo pre"}"#),
        ),
    ];
    if let Some(npmrc) = npmrc {
        files.push(("/app/.npmrc".into(), npmrc.into()));
    }
    let files: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect();
    tree(&files, &[])
}

#[test]
fn npm_before_12_runs_every_packages_scripts_dependencies_first() {
    let b = npm_tree("", None);
    let p = plan_of(&b, Manager::Npm);
    assert_eq!(
        names(&p),
        vec![
            "a:postinstall",
            // `install` defaults to node-gyp for a package with binding.gyp.
            "b:install",
            "a:preinstall",
            "d:install",
            "app:postinstall,prepare",
        ]
    );
    assert_eq!(p.steps[1].events[0].command, "node-gyp rebuild");
    assert_eq!(p.steps[2].dir, "/app/node_modules/d/node_modules/a");
    assert!(p.steps.last().unwrap().project);
    assert!(p.blocked.is_empty());
}

#[test]
fn npm_12_runs_only_what_allow_scripts_allows() {
    let b = npm_tree(
        r#","allowScripts":{"a@1.2.0":true,"d":true,"b":false}"#,
        None,
    );
    let p = plan_of(&b, Manager::Npm);
    assert_eq!(
        names(&p),
        vec!["a:postinstall", "d:install", "app:postinstall,prepare"]
    );
    assert_eq!(p.blocked, vec!["a@2.0.0", "b@1.0.0"]);
    // Without the field, a project on npm 12 runs no dependency's.
    let b = npm_tree(r#","packageManager":"npm@12.2.3""#, None);
    let p = plan_of(&b, Manager::Npm);
    assert_eq!(names(&p), vec!["app:postinstall,prepare"]);
    assert_eq!(p.blocked.len(), 4);
    // Unless told to run them all.
    let b = npm_tree(
        r#","packageManager":"npm@12.2.3""#,
        Some("dangerously-allow-all-scripts=true\n"),
    );
    assert_eq!(plan_of(&b, Manager::Npm).steps.len(), 5);
}

#[test]
fn ignore_scripts_runs_nothing() {
    let b = npm_tree("", Some("ignore-scripts=true\n"));
    let p = plan_of(&b, Manager::Npm);
    assert!(p.ignored);
    assert!(p.steps.is_empty());
}

/// pnpm's store: each package in `.pnpm/<id>/node_modules/<name>`, its
/// dependencies linked beside it, and a workspace package linked in.
fn pnpm_tree(extra_files: &[(&str, &str)], root_extra: &str) -> SnapshotBuilder {
    let root = pkg("app", "1.0.0", root_extra);
    let web = pkg(
        "web",
        "0.0.0",
        r#","dependencies":{"sharp":"1"},"scripts":{"postinstall":"prisma generate"}"#,
    );
    let sharp = pkg(
        "sharp",
        "0.34.0",
        r#","dependencies":{"detect":"1"},"scripts":{"install":"node install.js"}"#,
    );
    let detect = pkg(
        "detect",
        "1.0.0",
        r#","scripts":{"postinstall":"node d.js"}"#,
    );
    let mut files: Vec<(&str, &str)> = vec![
        ("/app/package.json", &root),
        ("/app/packages/web/package.json", &web),
        (
            "/app/node_modules/.pnpm/sharp@0.34.0/node_modules/sharp/package.json",
            &sharp,
        ),
        (
            "/app/node_modules/.pnpm/detect@1.0.0/node_modules/detect/package.json",
            &detect,
        ),
    ];
    files.extend_from_slice(extra_files);
    tree(
        &files,
        &[
            ("/app/node_modules/web", "../packages/web"),
            (
                "/app/packages/web/node_modules/sharp",
                "../../../node_modules/.pnpm/sharp@0.34.0/node_modules/sharp",
            ),
            (
                "/app/node_modules/.pnpm/sharp@0.34.0/node_modules/detect",
                "../../detect@1.0.0/node_modules/detect",
            ),
        ],
    )
}

#[test]
fn pnpm_10_builds_only_what_it_is_allowed_to() {
    // Nothing allowed: only the workspace's own scripts.
    let b = pnpm_tree(&[], "");
    let p = plan_of(&b, Manager::Pnpm);
    assert_eq!(names(&p), vec!["web:postinstall"]);
    assert_eq!(p.steps[0].dir, "/app/packages/web");
    assert_eq!(p.blocked, vec!["detect@1.0.0", "sharp@0.34.0"]);

    // allowBuilds in pnpm-workspace.yaml, a version range included.
    let b = pnpm_tree(
        &[(
            "/app/pnpm-workspace.yaml",
            "packages: ['packages/*']\nallowBuilds:\n  sharp: true\n  'detect@0.9.0 || 1.0.0': true\n",
        )],
        "",
    );
    let p = plan_of(&b, Manager::Pnpm);
    assert_eq!(
        names(&p),
        vec!["detect:postinstall", "sharp:install", "web:postinstall"]
    );

    // onlyBuiltDependencies in package.json's `pnpm` field.
    let b = pnpm_tree(&[], r#","pnpm":{"onlyBuiltDependencies":["sharp"]}"#);
    assert_eq!(
        names(&plan_of(&b, Manager::Pnpm)),
        vec!["sharp:install", "web:postinstall"]
    );

    // dangerouslyAllowAllBuilds, less what allowBuilds denies.
    let b = pnpm_tree(
        &[(
            "/app/pnpm-workspace.yaml",
            "dangerouslyAllowAllBuilds: true\nallowBuilds:\n  detect: false\n",
        )],
        "",
    );
    assert_eq!(
        names(&plan_of(&b, Manager::Pnpm)),
        vec!["sharp:install", "web:postinstall"]
    );
}

fn plan_of(b: &SnapshotBuilder, manager: Manager) -> Plan {
    plan(b.fs(), manager, "/app")
}

#[test]
fn pnpm_9_builds_everything_but_never_built() {
    let b = pnpm_tree(
        &[],
        r#","packageManager":"pnpm@9.15.0","pnpm":{"neverBuiltDependencies":["detect"]}"#,
    );
    assert_eq!(
        names(&plan_of(&b, Manager::Pnpm)),
        vec!["sharp:install", "web:postinstall"]
    );
    let b = pnpm_tree(
        &[("/app/pnpm-workspace.yaml", "ignoreDepScripts: true\n")],
        "",
    );
    assert_eq!(names(&plan_of(&b, Manager::Pnpm)), vec!["web:postinstall"]);
    let b = pnpm_tree(&[("/app/pnpm-workspace.yaml", "ignoreScripts: true\n")], "");
    assert!(plan_of(&b, Manager::Pnpm).ignored);
}

#[test]
fn bun_trusts_its_own_list_unless_the_project_names_one() {
    let esbuild = pkg(
        "esbuild",
        "0.25.0",
        r#","scripts":{"postinstall":"node install.js"}"#,
    );
    let odd = pkg("odd", "1.0.0", r#","scripts":{"postinstall":"curl x"}"#);
    let files = |root: String| {
        vec![
            ("/app/package.json".to_string(), root),
            (
                "/app/node_modules/esbuild/package.json".into(),
                esbuild.clone(),
            ),
            ("/app/node_modules/odd/package.json".into(), odd.clone()),
        ]
    };
    let build = |root: String| {
        let f = files(root);
        let f: Vec<(&str, &str)> = f.iter().map(|(p, c)| (p.as_str(), c.as_str())).collect();
        tree(&f, &[])
    };
    let b = build(pkg("app", "1.0.0", ""));
    let p = plan_of(&b, Manager::Bun);
    assert_eq!(names(&p), vec!["esbuild:postinstall"]);
    assert_eq!(p.blocked, vec!["odd@1.0.0"]);
    // `trustedDependencies` replaces the list.
    let b = build(pkg("app", "1.0.0", r#","trustedDependencies":["odd"]"#));
    assert_eq!(names(&plan_of(&b, Manager::Bun)), vec!["odd:postinstall"]);
    let b = build(pkg("app", "1.0.0", r#","trustedDependencies":[]"#));
    assert!(plan_of(&b, Manager::Bun).steps.is_empty());
}

#[test]
fn nothing_to_run_is_an_empty_plan() {
    let b = tree(
        &[
            (
                "/app/package.json",
                &pkg("app", "1.0.0", r#","scripts":{"test":"x"}"#),
            ),
            ("/app/node_modules/c/package.json", &pkg("c", "1.0.0", "")),
        ],
        &[],
    );
    let p = plan_of(&b, Manager::Npm);
    assert_eq!(p, Plan::default());
}

#[test]
fn matchers_read_scopes_and_versions() {
    let m = Matcher::parse("@scope/pkg@1.2.3 || ^2");
    assert_eq!(m.name, "@scope/pkg");
    assert!(m.matches("@scope/pkg", "1.2.3"));
    assert!(m.matches("@scope/pkg", "2.4.0"));
    assert!(!m.matches("@scope/pkg", "1.2.4"));
    let bare = Matcher::parse("@scope/pkg");
    assert!(bare.versions.is_none() && bare.matches("@scope/pkg", "9.9.9"));
    assert!(Matcher::parse("").name.is_empty());
    assert_eq!(
        package_manager_major(
            &serde_json::json!({"packageManager": "pnpm@10.20.0+sha512.abc"}),
            "pnpm"
        ),
        Some(10)
    );
    assert_eq!(
        package_manager_major(
            &serde_json::json!({"devEngines": {"packageManager": {"name": "npm", "version": "^12.1.0"}}}),
            "npm"
        ),
        Some(12)
    );
}

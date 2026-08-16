//! Finding the desktop entries on a host.
//!
//! Every input that varies per machine — `HOME`, the XDG variables, `PATH` —
//! is a parameter rather than a read of the ambient environment, so the tests
//! describe a Linux host while running on whatever the developer has.

use std::path::{Path, PathBuf};

use crate::entry::{DesktopEntry, ParseContext, Skipped, parse_entry, try_exec_key};

/// What a scan turned up, including what it rejected. A launcher that shows
/// nothing is a bug report; a launcher that shows nothing *and* can say "62
/// entries, all hidden" is a diagnosis.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanStats {
    pub listed: usize,
    pub hidden: usize,
    pub not_an_application: usize,
    pub wrong_desktop: usize,
    pub no_exec: usize,
    pub malformed: usize,
    /// `TryExec` named a binary that is not installed.
    pub missing_binary: usize,
    /// Shadowed by a higher-precedence directory with the same desktop id.
    pub shadowed: usize,
    pub unreadable: usize,
}

#[derive(Debug, Default, Clone)]
pub struct Scan {
    pub entries: Vec<DesktopEntry>,
    pub stats: ScanStats,
}

/// The `applications` directories, in precedence order: `XDG_DATA_HOME` first,
/// then each of `XDG_DATA_DIRS`. Flatpak and Snap exports arrive through
/// `XDG_DATA_DIRS` on any host where they are installed, so they need no
/// special casing here.
pub fn application_dirs(
    home: Option<&Path>,
    data_home: Option<&str>,
    data_dirs: Option<&str>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match data_home.filter(|v| !v.is_empty()) {
        Some(value) => dirs.push(PathBuf::from(value)),
        None => {
            if let Some(home) = home {
                dirs.push(home.join(".local/share"));
            }
        }
    }
    let dirs_value = data_dirs
        .filter(|v| !v.is_empty())
        .unwrap_or("/usr/local/share:/usr/share");
    dirs.extend(
        dirs_value
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
    );

    let mut out = Vec::new();
    for dir in dirs {
        let applications = dir.join("applications");
        if !out.contains(&applications) {
            out.push(applications);
        }
    }
    out
}

/// The data directories themselves, for icon theme roots.
pub fn data_dirs(data_home: Option<&str>, data_dirs: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(value) = data_home.filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(value));
    }
    let value = data_dirs
        .filter(|v| !v.is_empty())
        .unwrap_or("/usr/local/share:/usr/share");
    out.extend(
        value
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
    );
    out
}

/// Scan `dirs` in precedence order. The first entry with a given desktop id
/// wins, which is how a user's `~/.local/share/applications` override shadows
/// the system copy.
pub fn scan(dirs: &[PathBuf], ctx: &ParseContext, path_env: Option<&str>) -> Scan {
    let mut scan = Scan::default();
    let mut seen_ids: Vec<String> = Vec::new();

    for dir in dirs {
        let mut files = Vec::new();
        collect_desktop_files(dir, dir, &mut files, 0);
        files.sort();
        for (id, path) in files {
            if seen_ids.contains(&id) {
                scan.stats.shadowed += 1;
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                scan.stats.unreadable += 1;
                continue;
            };
            if let Some(binary) = try_exec_key(&text)
                && which(&binary, path_env).is_none()
            {
                scan.stats.missing_binary += 1;
                seen_ids.push(id);
                continue;
            }
            match parse_entry(&text, &id, ctx) {
                Ok(entry) => {
                    seen_ids.push(id);
                    scan.stats.listed += 1;
                    scan.entries.push(entry);
                }
                Err(reason) => {
                    // A hidden entry still claims its id: the system copy of a
                    // deliberately hidden app must not reappear from a lower
                    // precedence directory.
                    seen_ids.push(id);
                    match reason {
                        Skipped::Hidden => scan.stats.hidden += 1,
                        Skipped::NotAnApplication => scan.stats.not_an_application += 1,
                        Skipped::WrongDesktop => scan.stats.wrong_desktop += 1,
                        Skipped::NoExec => scan.stats.no_exec += 1,
                        Skipped::Malformed => scan.stats.malformed += 1,
                    }
                }
            }
        }
    }

    scan.entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    scan
}

/// Depth-limited recursive walk. The spec allows subdirectories, whose names
/// become part of the desktop id with `/` replaced by `-`.
fn collect_desktop_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>, depth: u32) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_desktop_files(root, &path, out, depth + 1);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let id = relative.to_string_lossy().replace('/', "-");
        out.push((id, path));
    }
}

/// Resolve a binary the way a shell would. An absolute or relative path is
/// checked directly, per the `TryExec` definition.
pub fn which(binary: &str, path_env: Option<&str>) -> Option<PathBuf> {
    if binary.contains('/') {
        let path = PathBuf::from(binary);
        return is_executable(&path).then_some(path);
    }
    let path_env = path_env.unwrap_or("/usr/local/bin:/usr/bin:/bin");
    for dir in path_env.split(':').filter(|s| !s.is_empty()) {
        let candidate = Path::new(dir).join(binary);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempTree;

    fn app(name: &str, extra: &str) -> String {
        format!("[Desktop Entry]\nType=Application\nName={name}\nExec={name}\n{extra}")
    }

    #[test]
    fn application_dirs_follow_xdg_precedence() {
        let dirs = application_dirs(
            Some(Path::new("/home/astrid")),
            None,
            Some("/var/lib/flatpak/exports/share:/usr/share"),
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/home/astrid/.local/share/applications"),
                PathBuf::from("/var/lib/flatpak/exports/share/applications"),
                PathBuf::from("/usr/share/applications"),
            ]
        );
    }

    #[test]
    fn application_dirs_default_when_xdg_is_unset() {
        let dirs = application_dirs(Some(Path::new("/root")), None, None);
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/root/.local/share/applications"),
                PathBuf::from("/usr/local/share/applications"),
                PathBuf::from("/usr/share/applications"),
            ]
        );
    }

    #[test]
    fn finds_entries_and_sorts_them_by_name() {
        let t = TempTree::new("scan");
        t.write("apps/zebra.desktop", &app("Zebra", ""));
        t.write("apps/alpha.desktop", &app("Alpha", ""));
        let scan = scan(&[t.path("apps")], &ParseContext::default(), Some(""));
        assert_eq!(
            scan.entries
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "Zebra"]
        );
        assert_eq!(scan.stats.listed, 2);
    }

    #[test]
    fn subdirectories_become_part_of_the_id() {
        let t = TempTree::new("scan-nested");
        t.write("apps/kde/konsole.desktop", &app("Konsole", ""));
        let scan = scan(&[t.path("apps")], &ParseContext::default(), Some(""));
        assert_eq!(scan.entries[0].id, "kde-konsole.desktop");
    }

    #[test]
    fn a_user_override_shadows_the_system_copy() {
        let t = TempTree::new("scan-shadow");
        t.write("user/firefox.desktop", &app("Firefox Nightly", ""));
        t.write("system/firefox.desktop", &app("Firefox", ""));
        let scan = scan(
            &[t.path("user"), t.path("system")],
            &ParseContext::default(),
            Some(""),
        );
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].name, "Firefox Nightly");
        assert_eq!(scan.stats.shadowed, 1);
    }

    #[test]
    fn a_hidden_override_suppresses_the_system_copy_entirely() {
        // This is the mechanism distributions use to hide an entry: an empty
        // override with NoDisplay=true. Letting the system copy through would
        // undo it.
        let t = TempTree::new("scan-hide");
        t.write("user/firefox.desktop", &app("Firefox", "NoDisplay=true\n"));
        t.write("system/firefox.desktop", &app("Firefox", ""));
        let scan = scan(
            &[t.path("user"), t.path("system")],
            &ParseContext::default(),
            Some(""),
        );
        assert!(scan.entries.is_empty());
        assert_eq!(scan.stats.hidden, 1);
        assert_eq!(scan.stats.shadowed, 1);
    }

    #[test]
    fn counts_why_entries_were_rejected() {
        let t = TempTree::new("scan-stats");
        t.write("apps/good.desktop", &app("Good", ""));
        t.write("apps/hidden.desktop", &app("Hidden", "NoDisplay=true\n"));
        t.write(
            "apps/link.desktop",
            "[Desktop Entry]\nType=Link\nName=L\nURL=x\n",
        );
        t.write(
            "apps/noexec.desktop",
            "[Desktop Entry]\nType=Application\nName=N\n",
        );
        t.write("apps/junk.desktop", "not an ini file\n");
        t.write("apps/ignored.txt", "not a desktop file");
        let scan = scan(&[t.path("apps")], &ParseContext::default(), Some(""));
        assert_eq!(
            scan.stats,
            ScanStats {
                listed: 1,
                hidden: 1,
                not_an_application: 1,
                no_exec: 1,
                malformed: 1,
                ..ScanStats::default()
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn try_exec_drops_entries_whose_binary_is_not_installed() {
        let t = TempTree::new("scan-tryexec");
        t.write_executable("bin/installed", "#!/bin/sh\n");
        t.write(
            "apps/installed.desktop",
            &app("Installed", "TryExec=installed\n"),
        );
        t.write("apps/missing.desktop", &app("Missing", "TryExec=missing\n"));
        let scan = scan(
            &[t.path("apps")],
            &ParseContext::default(),
            Some(&t.path("bin").to_string_lossy()),
        );
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].name, "Installed");
        assert_eq!(scan.stats.missing_binary, 1);
    }

    #[cfg(unix)]
    #[test]
    fn which_requires_the_executable_bit() {
        let t = TempTree::new("which");
        t.write("bin/not-exec", "#!/bin/sh\n");
        t.write_executable("bin/yes-exec", "#!/bin/sh\n");
        let path = t.path("bin").to_string_lossy().into_owned();
        assert!(which("not-exec", Some(&path)).is_none());
        assert!(which("yes-exec", Some(&path)).is_some());
        assert!(which("nothing-here", Some(&path)).is_none());
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        let scan = scan(
            &[PathBuf::from("/definitely/not/here")],
            &ParseContext::default(),
            Some(""),
        );
        assert!(scan.entries.is_empty());
        assert_eq!(scan.stats, ScanStats::default());
    }
}

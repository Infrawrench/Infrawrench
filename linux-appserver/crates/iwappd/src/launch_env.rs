//! The environment applications are spawned into.
//!
//! This is where "works on a bare cloud VM" is won or lost. A stock server
//! image has no GPU, frequently no mesa, and often no `XDG_RUNTIME_DIR` at
//! all — the directory `/run/user/$UID` is created by pam_systemd at login,
//! and an SSH session on a minimal image may never have had one. Toolkits
//! respond to that by trying GL and dying, so every one of them is pushed onto
//! a software path explicitly.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Variables that would drag an app back onto the host's (nonexistent)
/// display, or onto a GPU we do not have.
const STRIPPED: &[&str] = &[
    "DISPLAY",
    "WAYLAND_SOCKET",
    "XAUTHORITY",
    "GDK_SCALE",
    "GDK_DPI_SCALE",
    "QT_SCALE_FACTOR",
    "QT_AUTO_SCREEN_SCALE_FACTOR",
    "SDL_VIDEODRIVER",
    "CLUTTER_BACKEND",
    "__GLX_VENDOR_LIBRARY_NAME",
    "LIBVA_DRIVER_NAME",
    "VDPAU_DRIVER",
];

/// Build the environment for a launched application.
///
/// `inherited` is the daemon's own environment (locale, PATH, HOME and the
/// user's own settings are worth keeping); everything display-related is
/// replaced rather than merged.
pub fn launch_env(
    inherited: &BTreeMap<String, String>,
    runtime_dir: &Path,
    wayland_display: &str,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = inherited
        .iter()
        .filter(|(key, _)| !STRIPPED.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    env.insert(
        "XDG_RUNTIME_DIR".into(),
        runtime_dir.to_string_lossy().into_owned(),
    );
    env.insert("WAYLAND_DISPLAY".into(), wayland_display.to_owned());
    env.insert("XDG_SESSION_TYPE".into(), "wayland".into());
    env.insert("XDG_CURRENT_DESKTOP".into(), "Infrawrench".into());

    // Toolkit backends: pick Wayland explicitly. Several of these default to
    // X11 when DISPLAY is set, and we have just unset it, at which point some
    // of them exit rather than falling back.
    env.insert("GDK_BACKEND".into(), "wayland".into());
    env.insert("QT_QPA_PLATFORM".into(), "wayland".into());
    env.insert("SDL_VIDEODRIVER".into(), "wayland".into());
    env.insert("MOZ_ENABLE_WAYLAND".into(), "1".into());
    env.insert("ELECTRON_OZONE_PLATFORM_HINT".into(), "wayland".into());
    env.insert("_JAVA_AWT_WM_NONREPARENTING".into(), "1".into());

    // Software rendering. GSK_RENDERER is the load-bearing one: GTK4 defaults
    // to a GL renderer and fails outright with no mesa, which is most bare
    // server images.
    env.insert("GSK_RENDERER".into(), "cairo".into());
    env.insert("QT_QUICK_BACKEND".into(), "software".into());
    env.insert("LIBGL_ALWAYS_SOFTWARE".into(), "1".into());
    env.insert("WEBKIT_DISABLE_COMPOSITING_MODE".into(), "1".into());

    env
}

/// Find a usable `XDG_RUNTIME_DIR`, creating a private one when the host has
/// none.
///
/// The fallback lives under `/tmp` with 0700 permissions and the uid in its
/// name. That is deliberately the same shape systemd would have made: Wayland
/// refuses to put its socket anywhere group- or world-writable, and an app
/// that cannot find a runtime dir usually fails with a message about dconf
/// rather than about the directory.
pub fn resolve_runtime_dir(
    existing: Option<&str>,
    uid: u32,
    tmp: &Path,
) -> std::io::Result<PathBuf> {
    if let Some(dir) = existing.filter(|d| !d.is_empty()) {
        let path = PathBuf::from(dir);
        if is_usable(&path) {
            return Ok(path);
        }
    }
    let fallback = tmp.join(format!("infrawrench-run-{uid}"));
    create_private_dir(&fallback)?;
    Ok(fallback)
}

fn is_usable(path: &Path) -> bool {
    path.is_dir()
        && !path
            .metadata()
            .map(|m| m.permissions().readonly())
            .unwrap_or(true)
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if path.is_dir() {
        // Re-assert the mode: a previous run may have left it, and an
        // inherited 0755 would make Wayland refuse the socket.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        return Ok(());
    }
    std::fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

/// The socket name for a session. Namespaced so two Infrawrench sessions on
/// one host — a second browser tab, a colleague on the same box — do not
/// collide.
pub fn wayland_display_name(session_id: &str) -> String {
    let safe: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    format!("wayland-iw-{safe}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inherited() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("HOME".to_string(), "/home/astrid".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("LANG".to_string(), "en_GB.UTF-8".to_string()),
            ("DISPLAY".to_string(), ":0".to_string()),
            ("XAUTHORITY".to_string(), "/tmp/.Xauth".to_string()),
            ("SDL_VIDEODRIVER".to_string(), "x11".to_string()),
        ])
    }

    #[test]
    fn keeps_the_users_own_environment() {
        let env = launch_env(&inherited(), Path::new("/run/user/1000"), "wayland-iw-a");
        assert_eq!(env["HOME"], "/home/astrid");
        assert_eq!(env["LANG"], "en_GB.UTF-8");
        assert_eq!(env["PATH"], "/usr/bin");
    }

    #[test]
    fn strips_the_hosts_x11_session() {
        // An SSH session with X forwarding has DISPLAY set. Leaving it would
        // send GTK to the forwarded X server rather than to us.
        let env = launch_env(&inherited(), Path::new("/run/user/1000"), "wayland-iw-a");
        assert!(!env.contains_key("DISPLAY"));
        assert!(!env.contains_key("XAUTHORITY"));
    }

    #[test]
    fn overrides_a_stripped_variable_it_also_sets() {
        let env = launch_env(&inherited(), Path::new("/run/user/1000"), "wayland-iw-a");
        assert_eq!(env["SDL_VIDEODRIVER"], "wayland");
    }

    #[test]
    fn forces_software_rendering() {
        let env = launch_env(&inherited(), Path::new("/run/user/1000"), "wayland-iw-a");
        assert_eq!(env["GSK_RENDERER"], "cairo");
        assert_eq!(env["QT_QUICK_BACKEND"], "software");
        assert_eq!(env["LIBGL_ALWAYS_SOFTWARE"], "1");
    }

    #[test]
    fn points_every_toolkit_at_our_socket() {
        let env = launch_env(&inherited(), Path::new("/run/user/1000"), "wayland-iw-abc");
        assert_eq!(env["WAYLAND_DISPLAY"], "wayland-iw-abc");
        assert_eq!(env["XDG_RUNTIME_DIR"], "/run/user/1000");
        assert_eq!(env["GDK_BACKEND"], "wayland");
        assert_eq!(env["QT_QPA_PLATFORM"], "wayland");
    }

    #[test]
    fn display_names_are_namespaced_and_sanitised() {
        assert_eq!(wayland_display_name("abc-123"), "wayland-iw-abc-123");
        assert_eq!(
            wayland_display_name("../../etc/passwd"),
            "wayland-iw-etcpasswd"
        );
        assert!(wayland_display_name(&"x".repeat(200)).len() <= "wayland-iw-".len() + 32);
    }

    #[cfg(unix)]
    #[test]
    fn creates_a_private_runtime_dir_when_the_host_has_none() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("iwappd-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let dir = resolve_runtime_dir(None, 1000, &tmp).unwrap();
        assert_eq!(dir, tmp.join("infrawrench-run-1000"));
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "wayland refuses a loose runtime dir");

        // Second call is idempotent.
        assert_eq!(resolve_runtime_dir(None, 1000, &tmp).unwrap(), dir);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prefers_an_existing_runtime_dir() {
        let tmp = std::env::temp_dir().join(format!("iwappd-rt2-{}", std::process::id()));
        let existing = tmp.join("run-user-1000");
        std::fs::create_dir_all(&existing).unwrap();
        let dir = resolve_runtime_dir(Some(&existing.to_string_lossy()), 1000, &tmp).unwrap();
        assert_eq!(dir, existing);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn falls_back_when_the_declared_runtime_dir_does_not_exist() {
        let tmp = std::env::temp_dir().join(format!("iwappd-rt3-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = resolve_runtime_dir(Some("/run/user/9999"), 1000, &tmp).unwrap();
        assert_eq!(dir, tmp.join("infrawrench-run-1000"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

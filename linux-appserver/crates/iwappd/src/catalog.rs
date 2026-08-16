//! What is installed on this host, and what it looks like.

use std::collections::HashMap;

use iw_apps::{
    DesktopEntry, IconBudget, IconResolver, ParseContext, application_dirs, data_dirs,
    default_theme_roots, exec_argv, icon_data_url, scan, to_app_entry,
};
use iw_proto::AppEntry;

/// An app resolved to something spawnable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedApp {
    pub app_id: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    /// `Terminal=true`: we have no terminal emulator to put it in.
    pub needs_terminal: bool,
}

pub trait Catalog {
    fn list(&mut self, refresh: bool) -> Vec<AppEntry>;
    fn resolve(&mut self, app_id: &str) -> Option<ResolvedApp>;
    /// Icon for a window whose `app_id` we know, matched against desktop file
    /// ids and `StartupWMClass`.
    fn icon_for_app_id(&mut self, app_id: &str) -> Option<String>;
}

/// The real catalog: XDG desktop entries plus icon theme lookup.
pub struct FsCatalog {
    dirs: Vec<std::path::PathBuf>,
    ctx: ParseContext,
    path_env: Option<String>,
    resolver: IconResolver,
    budget: IconBudget,
    entries: Option<Vec<DesktopEntry>>,
    icons: HashMap<String, Option<String>>,
}

impl FsCatalog {
    /// Build from an environment map rather than reading the process
    /// environment, so the daemon can be pointed at a fixture in tests and at
    /// the user's real session in production.
    pub fn from_env(env: &std::collections::BTreeMap<String, String>, budget: IconBudget) -> Self {
        let home = env.get("HOME").map(std::path::PathBuf::from);
        let data_home = env.get("XDG_DATA_HOME").map(String::as_str);
        let xdg_data_dirs = env.get("XDG_DATA_DIRS").map(String::as_str);
        let theme = env
            .get("INFRAWRENCH_ICON_THEME")
            .cloned()
            .unwrap_or_else(|| "hicolor".to_owned());

        let data = data_dirs(data_home, xdg_data_dirs);
        let roots = default_theme_roots(home.as_deref(), &data);
        let fallbacks = data.iter().map(|d| d.join("pixmaps")).collect();

        Self {
            dirs: application_dirs(home.as_deref(), data_home, xdg_data_dirs),
            ctx: ParseContext {
                locales: iw_apps::locale_candidates(
                    env.get("LC_MESSAGES")
                        .or_else(|| env.get("LC_ALL"))
                        .or_else(|| env.get("LANG"))
                        .map(String::as_str)
                        .unwrap_or(""),
                ),
                ..ParseContext::default()
            },
            path_env: env.get("PATH").cloned(),
            resolver: IconResolver::new(&roots, fallbacks, &theme),
            budget,
            entries: None,
            icons: HashMap::new(),
        }
    }

    fn entries(&mut self, refresh: bool) -> &[DesktopEntry] {
        if refresh {
            self.entries = None;
            self.icons.clear();
        }
        if self.entries.is_none() {
            let result = scan(&self.dirs, &self.ctx, self.path_env.as_deref());
            self.entries = Some(result.entries);
        }
        self.entries.as_deref().unwrap_or_default()
    }
}

impl Catalog for FsCatalog {
    fn list(&mut self, refresh: bool) -> Vec<AppEntry> {
        let entries: Vec<DesktopEntry> = self.entries(refresh).to_vec();
        entries
            .iter()
            .map(|entry| {
                let icon = entry
                    .icon
                    .as_ref()
                    .and_then(|name| icon_data_url(&self.resolver, name, self.budget));
                to_app_entry(entry, icon)
            })
            .collect()
    }

    fn resolve(&mut self, app_id: &str) -> Option<ResolvedApp> {
        let entry = self.entries(false).iter().find(|e| e.id == app_id)?.clone();
        Some(ResolvedApp {
            app_id: entry.id.clone(),
            argv: exec_argv(&entry.exec, &entry.name, entry.icon.as_deref()),
            cwd: entry.working_dir.clone(),
            needs_terminal: entry.terminal,
        })
    }

    fn icon_for_app_id(&mut self, app_id: &str) -> Option<String> {
        if let Some(cached) = self.icons.get(app_id) {
            return cached.clone();
        }
        // A window's `app_id` is usually the desktop file id without the
        // suffix, but plenty of apps report something else entirely — which is
        // exactly what StartupWMClass exists to reconcile.
        let entries: Vec<DesktopEntry> = self.entries(false).to_vec();
        let matched = entries
            .iter()
            .find(|e| {
                e.id.trim_end_matches(".desktop")
                    .eq_ignore_ascii_case(app_id)
                    || e.wm_class
                        .as_deref()
                        .is_some_and(|c| c.eq_ignore_ascii_case(app_id))
            })
            .or_else(|| {
                // Last resort: match on the binary name, which is what a
                // window's app_id degrades to for toolkit-less clients.
                entries.iter().find(|e| {
                    exec_argv(&e.exec, &e.name, None)
                        .first()
                        .and_then(|bin| bin.rsplit('/').next())
                        .is_some_and(|bin| bin.eq_ignore_ascii_case(app_id))
                })
            });

        let icon = matched
            .and_then(|e| e.icon.clone())
            .and_then(|name| icon_data_url(&self.resolver, &name, self.budget));
        self.icons.insert(app_id.to_owned(), icon.clone());
        icon
    }
}

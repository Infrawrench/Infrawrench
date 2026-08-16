//! The launcher's half of the app server: what is installed on this host, what
//! it is called, and what it looks like.
//!
//! Everything here is pure filesystem work with the environment passed in, so
//! it builds and tests anywhere — which matters, because the compositor half of
//! `iwappd` only builds on Linux and this is where most of the fiddly rules
//! live.

pub mod base64;
mod entry;
mod icons;
mod ini;
mod scan;
#[cfg(test)]
mod testutil;

pub use entry::{
    DesktopEntry, ParseContext, Skipped, exec_argv, locale_candidates, parse_entry, parse_list,
    try_exec_key, unescape,
};
pub use icons::{IconFile, IconFormat, IconResolver, default_theme_roots};
pub use ini::parse_ini;
pub use scan::{Scan, ScanStats, application_dirs, data_dirs, scan, which};

use iw_proto::AppEntry;

/// How much icon we are willing to send.
///
/// The cap is a tab-bar budget, not an aesthetic one: workspace tabs persist to
/// `localStorage`, so a session with thirty tabs open has to fit in a few
/// hundred kilobytes with room to spare. A 48px PNG is typically 1–3 KB.
#[derive(Debug, Clone, Copy)]
pub struct IconBudget {
    pub target_size: u32,
    pub max_bytes: usize,
}

impl Default for IconBudget {
    fn default() -> Self {
        Self {
            target_size: 48,
            max_bytes: 6 * 1024,
        }
    }
}

/// Resolve an icon name to a `data:` URL, stepping down through smaller sizes
/// until one fits the budget.
///
/// XPM is skipped outright — no browser renders it, so sending it would put a
/// broken image in the tab bar. SVG is kept: it is text, it usually compresses
/// to less than the PNG, and an `<img>` renders it natively.
pub fn icon_data_url(resolver: &IconResolver, name: &str, budget: IconBudget) -> Option<String> {
    let mut sizes = vec![budget.target_size];
    sizes.extend(
        [48, 32, 24, 16]
            .into_iter()
            .filter(|s| *s != budget.target_size),
    );

    for size in sizes {
        let Some(icon) = resolver.find(name, size) else {
            continue;
        };
        if icon.format == IconFormat::Xpm {
            continue;
        }
        let Ok(bytes) = std::fs::read(&icon.path) else {
            continue;
        };
        if bytes.len() > budget.max_bytes {
            continue;
        }
        return Some(base64::data_url(icon.format.mime(), &bytes));
    }
    None
}

/// Project a parsed desktop entry onto the wire type the client renders.
pub fn to_app_entry(entry: &DesktopEntry, icon: Option<String>) -> AppEntry {
    AppEntry {
        id: entry.id.clone(),
        name: entry.name.clone(),
        comment: entry.comment.clone(),
        categories: entry.categories.clone(),
        icon,
        wm_class: entry.wm_class.clone(),
        needs_terminal: entry.terminal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use testutil::TempTree;

    fn tree() -> TempTree {
        let t = TempTree::new("lib");
        t.write(
            "icons/hicolor/index.theme",
            "[Icon Theme]\nDirectories=16x16/apps,48x48/apps,scalable/apps\n\
             [16x16/apps]\nSize=16\nType=Fixed\n\
             [48x48/apps]\nSize=48\nType=Fixed\n\
             [scalable/apps]\nSize=128\nType=Scalable\nMinSize=64\nMaxSize=512\n",
        );
        t
    }

    fn resolver(t: &TempTree) -> IconResolver {
        IconResolver::new(&[t.path("icons")], vec![], "hicolor")
    }

    #[test]
    fn encodes_an_icon_as_a_data_url() {
        let t = tree();
        t.write("icons/hicolor/48x48/apps/thing.png", "PNGDATA");
        let url = icon_data_url(&resolver(&t), "thing", IconBudget::default()).unwrap();
        assert_eq!(url, "data:image/png;base64,UE5HREFUQQ==");
    }

    #[test]
    fn steps_down_a_size_when_the_preferred_icon_blows_the_budget() {
        let t = tree();
        t.write("icons/hicolor/48x48/apps/thing.png", &"x".repeat(9000));
        t.write("icons/hicolor/16x16/apps/thing.png", "small");
        let url = icon_data_url(&resolver(&t), "thing", IconBudget::default()).unwrap();
        assert_eq!(url, base64::data_url("image/png", b"small"));
    }

    #[test]
    fn gives_up_rather_than_sending_something_oversized() {
        let t = tree();
        t.write("icons/hicolor/48x48/apps/thing.png", &"x".repeat(9000));
        assert!(icon_data_url(&resolver(&t), "thing", IconBudget::default()).is_none());
    }

    #[test]
    fn keeps_svg_but_skips_xpm() {
        let t = tree();
        t.write("icons/hicolor/scalable/apps/vector.svg", "<svg/>");
        t.write("icons/hicolor/48x48/apps/ancient.xpm", "/* XPM */");
        let r = resolver(&t);
        assert!(
            icon_data_url(&r, "vector", IconBudget::default())
                .unwrap()
                .starts_with("data:image/svg+xml;base64,")
        );
        assert!(icon_data_url(&r, "ancient", IconBudget::default()).is_none());
    }

    #[test]
    fn a_missing_icon_leaves_the_entry_without_one() {
        let t = tree();
        let entry = parse_entry(
            "[Desktop Entry]\nType=Application\nName=Thing\nExec=thing\nIcon=nope\n",
            "thing.desktop",
            &ParseContext::default(),
        )
        .unwrap();
        let icon = icon_data_url(&resolver(&t), "nope", IconBudget::default());
        let wire = to_app_entry(&entry, icon);
        assert_eq!(wire.name, "Thing");
        assert!(wire.icon.is_none());
    }
}

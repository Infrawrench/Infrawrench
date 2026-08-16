//! Icon theme lookup, per the freedesktop Icon Theme Specification.
//!
//! `Icon=firefox` in a desktop file is not a path — it is a name to be
//! resolved against a stack of themes, each of which declares subdirectories
//! with a nominal size, a scale, and a matching rule. The lookup order is what
//! decides whether a launcher shows the user's themed icon or the generic
//! fallback, so it is worth doing properly rather than globbing for
//! `*/48x48/*/firefox.png`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::ini::parse_ini;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconFormat {
    Png,
    Svg,
    Xpm,
}

impl IconFormat {
    fn from_extension(ext: &str) -> Option<Self> {
        Some(match ext {
            "png" => Self::Png,
            "svg" => Self::Svg,
            "xpm" => Self::Xpm,
            _ => return None,
        })
    }

    /// Preference when several formats exist at the same size. PNG first
    /// because we forward the bytes untouched; SVG would need a rasteriser we
    /// do not ship, and XPM is a museum piece.
    fn rank(self) -> u8 {
        match self {
            Self::Png => 0,
            Self::Svg => 1,
            Self::Xpm => 2,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Svg => "image/svg+xml",
            Self::Xpm => "image/x-xpixmap",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SizeKind {
    Fixed,
    Scalable,
    Threshold,
}

#[derive(Debug, Clone)]
struct IconDir {
    /// Path relative to the theme root, e.g. `48x48/apps`.
    subdir: String,
    size: u32,
    scale: u32,
    kind: SizeKind,
    min_size: u32,
    max_size: u32,
    threshold: u32,
}

impl IconDir {
    fn matches(&self, target: u32) -> bool {
        match self.kind {
            SizeKind::Fixed => self.size == target,
            SizeKind::Scalable => self.min_size <= target && target <= self.max_size,
            SizeKind::Threshold => {
                self.size.saturating_sub(self.threshold) <= target
                    && target <= self.size + self.threshold
            }
        }
    }

    /// How far this directory is from the size we want, for ranking when
    /// nothing matches exactly.
    fn distance(&self, target: u32) -> u32 {
        match self.kind {
            SizeKind::Scalable if target < self.min_size => self.min_size - target,
            SizeKind::Scalable if target > self.max_size => target - self.max_size,
            SizeKind::Scalable => 0,
            _ => self.size.abs_diff(target),
        }
    }
}

#[derive(Debug, Clone)]
struct Theme {
    root_dirs: Vec<PathBuf>,
    dirs: Vec<IconDir>,
    inherits: Vec<String>,
}

/// A resolved icon file on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconFile {
    pub path: PathBuf,
    pub format: IconFormat,
    /// Nominal size of the directory it came from; 0 for a flat legacy dir.
    pub size: u32,
}

/// Resolves icon names against a theme stack.
#[derive(Debug, Clone)]
pub struct IconResolver {
    /// Themes in lookup order: the configured theme, everything it inherits,
    /// then hicolor.
    order: Vec<String>,
    themes: HashMap<String, Theme>,
    /// Flat legacy directories (`/usr/share/pixmaps`), searched last.
    fallback_dirs: Vec<PathBuf>,
}

impl IconResolver {
    /// `roots` are the directories that contain themes (`~/.icons`,
    /// `$XDG_DATA_DIRS/icons`), `fallback_dirs` the flat ones.
    pub fn new(roots: &[PathBuf], fallback_dirs: Vec<PathBuf>, theme: &str) -> Self {
        let mut themes: HashMap<String, Theme> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut queue: Vec<String> = vec![theme.to_owned()];

        while let Some(name) = queue.first().cloned() {
            queue.remove(0);
            if !seen.insert(name.clone()) {
                continue;
            }
            let Some(loaded) = load_theme(roots, &name) else {
                continue;
            };
            queue.extend(loaded.inherits.iter().cloned());
            order.push(name.clone());
            themes.insert(name, loaded);
        }

        // hicolor is the mandated fallback and every theme inherits it
        // implicitly, whether or not it says so.
        if !seen.contains("hicolor")
            && let Some(hicolor) = load_theme(roots, "hicolor")
        {
            order.push("hicolor".to_owned());
            themes.insert("hicolor".to_owned(), hicolor);
        }

        Self {
            order,
            themes,
            fallback_dirs,
        }
    }

    /// Themes actually found on disk, in lookup order. Mostly useful for
    /// diagnostics — "why is this icon generic" is a common question.
    pub fn theme_order(&self) -> &[String] {
        &self.order
    }

    /// Find the best file for `name` at `target` pixels.
    ///
    /// An absolute path in `name` is honoured directly, which is what the spec
    /// says and what a surprising number of desktop files rely on.
    pub fn find(&self, name: &str, target: u32) -> Option<IconFile> {
        if name.contains('/') {
            let path = PathBuf::from(name);
            let format = path
                .extension()
                .and_then(|e| e.to_str())
                .and_then(IconFormat::from_extension)?;
            return path.is_file().then_some(IconFile {
                path,
                format,
                size: target,
            });
        }

        // (theme index, size fit, format rank, file)
        let mut best: Option<(u32, u32, u8, IconFile)> = None;
        for (theme_index, theme_name) in self.order.iter().enumerate() {
            let Some(theme) = self.themes.get(theme_name) else {
                continue;
            };
            for dir in &theme.dirs {
                for root in &theme.root_dirs {
                    let base = root.join(&dir.subdir);
                    for ext in ["png", "svg", "xpm"] {
                        let candidate = base.join(format!("{name}.{ext}"));
                        if !candidate.is_file() {
                            continue;
                        }
                        let format = IconFormat::from_extension(ext).expect("known extension");
                        // Rank: theme first (an exact theme hit beats a
                        // better-sized inherited one), then how well the
                        // directory fits the size we asked for, and only then
                        // format. Size has to outrank format, or a 48px PNG
                        // wins over the scalable SVG when the caller asked for
                        // 256. Scale-2 directories lose to scale-1 at the same
                        // nominal size because we upload the bytes as-is.
                        let fit = if dir.matches(target) {
                            0
                        } else {
                            dir.distance(target).max(1)
                        };
                        let key = (
                            theme_index as u32,
                            fit,
                            format.rank() + if dir.scale > 1 { 4 } else { 0 },
                        );
                        let entry = IconFile {
                            path: candidate,
                            format,
                            size: dir.size,
                        };
                        match &best {
                            Some((t, f, d, _)) if (*t, *f, *d) <= key => {}
                            _ => best = Some((key.0, key.1, key.2, entry)),
                        }
                    }
                }
            }
            // A hit in this theme wins outright; inherited themes exist to
            // fill gaps, not to out-rank the user's choice.
            if let Some((t, _, _, file)) = &best
                && *t == theme_index as u32
            {
                return Some(file.clone());
            }
        }

        if let Some((_, _, _, file)) = best {
            return Some(file);
        }

        for dir in &self.fallback_dirs {
            for ext in ["png", "svg", "xpm"] {
                let candidate = dir.join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return Some(IconFile {
                        path: candidate,
                        format: IconFormat::from_extension(ext).expect("known extension"),
                        size: 0,
                    });
                }
            }
        }
        None
    }
}

fn load_theme(roots: &[PathBuf], name: &str) -> Option<Theme> {
    let mut root_dirs = Vec::new();
    let mut index_text = None;
    for root in roots {
        let dir = root.join(name);
        if !dir.is_dir() {
            continue;
        }
        root_dirs.push(dir.clone());
        if index_text.is_none()
            && let Ok(text) = std::fs::read_to_string(dir.join("index.theme"))
        {
            index_text = Some(text);
        }
    }
    if root_dirs.is_empty() {
        return None;
    }

    // A theme split across roots (system icons plus a user override) with no
    // readable index.theme still works if we treat its size directories the
    // way the legacy layout implies.
    let Some(text) = index_text else {
        return Some(Theme {
            dirs: guess_dirs(&root_dirs),
            root_dirs,
            inherits: Vec::new(),
        });
    };

    let groups = parse_ini(&text);
    let header = groups
        .iter()
        .find(|(name, _)| name == "Icon Theme")
        .map(|(_, keys)| keys);
    let inherits = header
        .and_then(|k| k.get("Inherits"))
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let declared: Vec<String> = header
        .and_then(|k| k.get("Directories"))
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let mut dirs = Vec::new();
    for subdir in declared {
        let Some((_, keys)) = groups.iter().find(|(name, _)| name == &subdir) else {
            continue;
        };
        let num = |key: &str, default: u32| {
            keys.get(key)
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(default)
        };
        let size = num("Size", 0);
        if size == 0 {
            continue;
        }
        let kind = match keys.get("Type").map(String::as_str) {
            Some("Fixed") => SizeKind::Fixed,
            Some("Scalable") => SizeKind::Scalable,
            // The spec's default is Threshold, and plenty of themes omit Type.
            _ => SizeKind::Threshold,
        };
        dirs.push(IconDir {
            subdir,
            size,
            scale: num("Scale", 1).max(1),
            kind,
            min_size: num("MinSize", size),
            max_size: num("MaxSize", size),
            threshold: num("Threshold", 2),
        });
    }

    Some(Theme {
        root_dirs,
        dirs,
        inherits,
    })
}

/// Recover size directories from the layout when `index.theme` is missing or
/// unreadable — `48x48/apps`, `scalable/apps`.
fn guess_dirs(roots: &[PathBuf]) -> Vec<IconDir> {
    let mut dirs = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let size = name
                .split_once('x')
                .and_then(|(w, _)| w.parse::<u32>().ok())
                .unwrap_or(if name == "scalable" { 256 } else { 0 });
            if size == 0 || !entry.path().is_dir() {
                continue;
            }
            let Ok(children) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            for child in children.flatten() {
                if child.path().is_dir() {
                    dirs.push(IconDir {
                        subdir: format!("{name}/{}", child.file_name().to_string_lossy()),
                        size,
                        scale: 1,
                        kind: if name == "scalable" {
                            SizeKind::Scalable
                        } else {
                            SizeKind::Threshold
                        },
                        min_size: if name == "scalable" { 1 } else { size },
                        max_size: if name == "scalable" { 512 } else { size },
                        threshold: 2,
                    });
                }
            }
        }
    }
    dirs
}

/// Theme roots in the order the spec searches them.
pub fn default_theme_roots(home: Option<&Path>, data_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home {
        roots.push(home.join(".icons"));
        roots.push(home.join(".local/share/icons"));
    }
    roots.extend(data_dirs.iter().map(|d| d.join("icons")));
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempTree;

    /// A theme stack: `custom` inherits `base`, and hicolor sits under both.
    fn tree() -> TempTree {
        let t = TempTree::new("icons");
        t.write(
            "icons/custom/index.theme",
            "[Icon Theme]\nName=Custom\nInherits=base\nDirectories=32x32/apps,48x48/apps,scalable/apps\n\
             [32x32/apps]\nSize=32\nType=Fixed\n\
             [48x48/apps]\nSize=48\nType=Threshold\nThreshold=4\n\
             [scalable/apps]\nSize=128\nType=Scalable\nMinSize=64\nMaxSize=512\n",
        );
        t.write("icons/custom/48x48/apps/firefox.png", "png-48");
        t.write("icons/custom/scalable/apps/firefox.svg", "svg");
        t.write("icons/custom/32x32/apps/gimp.png", "png-32");

        t.write(
            "icons/base/index.theme",
            "[Icon Theme]\nName=Base\nDirectories=64x64/apps\n[64x64/apps]\nSize=64\nType=Fixed\n",
        );
        t.write("icons/base/64x64/apps/gimp.png", "base-gimp");
        t.write("icons/base/64x64/apps/inkscape.png", "base-inkscape");

        t.write(
            "icons/hicolor/index.theme",
            "[Icon Theme]\nName=Hicolor\nDirectories=16x16/apps\n[16x16/apps]\nSize=16\nType=Fixed\n",
        );
        t.write("icons/hicolor/16x16/apps/vlc.png", "hicolor-vlc");
        t.write("pixmaps/legacy-app.png", "legacy");
        t
    }

    fn resolver(t: &TempTree) -> IconResolver {
        IconResolver::new(&[t.path("icons")], vec![t.path("pixmaps")], "custom")
    }

    #[test]
    fn walks_the_inheritance_chain_and_appends_hicolor() {
        let t = tree();
        assert_eq!(resolver(&t).theme_order(), &["custom", "base", "hicolor"]);
    }

    #[test]
    fn prefers_the_directory_that_matches_the_requested_size() {
        let t = tree();
        let icon = resolver(&t).find("firefox", 48).unwrap();
        assert_eq!(icon.format, IconFormat::Png);
        assert_eq!(icon.size, 48);
    }

    #[test]
    fn falls_back_to_a_scalable_directory_when_no_bitmap_fits() {
        let t = tree();
        let icon = resolver(&t).find("firefox", 256).unwrap();
        assert_eq!(icon.format, IconFormat::Svg);
    }

    #[test]
    fn the_chosen_theme_outranks_a_better_sized_inherited_icon() {
        // gimp exists at 32 in `custom` and at 64 in `base`. Asking for 64
        // must still give the user's theme.
        let t = tree();
        let icon = resolver(&t).find("gimp", 64).unwrap();
        assert!(icon.path.to_string_lossy().contains("custom"));
    }

    #[test]
    fn inherited_themes_fill_gaps() {
        let t = tree();
        let icon = resolver(&t).find("inkscape", 64).unwrap();
        assert!(icon.path.to_string_lossy().contains("base"));
    }

    #[test]
    fn hicolor_is_searched_even_though_no_theme_declares_it() {
        let t = tree();
        let icon = resolver(&t).find("vlc", 48).unwrap();
        assert!(icon.path.to_string_lossy().contains("hicolor"));
    }

    #[test]
    fn flat_legacy_directories_are_the_last_resort() {
        let t = tree();
        let icon = resolver(&t).find("legacy-app", 48).unwrap();
        assert!(icon.path.to_string_lossy().contains("pixmaps"));
        assert_eq!(icon.size, 0);
    }

    #[test]
    fn an_absolute_path_is_used_as_is() {
        let t = tree();
        let path = t.path("pixmaps/legacy-app.png");
        let icon = resolver(&t).find(&path.to_string_lossy(), 48).unwrap();
        assert_eq!(icon.path, path);
    }

    #[test]
    fn a_missing_icon_is_none_not_a_panic() {
        let t = tree();
        assert!(resolver(&t).find("no-such-icon", 48).is_none());
        assert!(resolver(&t).find("/nope/missing.png", 48).is_none());
    }

    #[test]
    fn a_theme_without_an_index_still_resolves_by_layout() {
        let t = TempTree::new("icons-noindex");
        t.write("icons/bare/64x64/apps/thing.png", "x");
        let r = IconResolver::new(&[t.path("icons")], vec![], "bare");
        assert_eq!(r.find("thing", 64).unwrap().size, 64);
    }

    #[test]
    fn a_cyclic_inherits_chain_terminates() {
        let t = TempTree::new("icons-cycle");
        t.write(
            "icons/a/index.theme",
            "[Icon Theme]\nInherits=b\nDirectories=16x16/apps\n[16x16/apps]\nSize=16\n",
        );
        t.write(
            "icons/b/index.theme",
            "[Icon Theme]\nInherits=a\nDirectories=16x16/apps\n[16x16/apps]\nSize=16\n",
        );
        t.write("icons/b/16x16/apps/x.png", "x");
        let r = IconResolver::new(&[t.path("icons")], vec![], "a");
        assert_eq!(r.theme_order(), &["a", "b"]);
        assert!(r.find("x", 16).is_some());
    }
}

//! Desktop entry parsing, per the freedesktop Desktop Entry Specification.
//!
//! This is a small file format with a lot of teeth: values carry their own
//! escape sequences, keys are localised, lists are semicolon-separated with
//! escaped semicolons, and `Exec` has a field-code language of its own that
//! must be stripped before the command is anything you can spawn. Getting any
//! of it wrong shows up as a launcher full of mangled names, or an app that
//! opens with a literal `%U` in its argument list.

use std::collections::HashMap;

/// One `[Desktop Entry]` group, reduced to the keys we act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopEntry {
    /// Desktop-file id, e.g. `org.gnome.Nautilus.desktop`.
    pub id: String,
    pub name: String,
    pub comment: Option<String>,
    /// Raw `Exec` value, field codes intact. Use [`exec_argv`] to spawn it.
    pub exec: String,
    pub icon: Option<String>,
    pub categories: Vec<String>,
    /// `Terminal=true`: needs a terminal emulator, which we do not provide.
    pub terminal: bool,
    /// `StartupWMClass` — how a window whose `app_id` differs from its desktop
    /// file id still gets the right icon.
    pub wm_class: Option<String>,
    /// `Path`: working directory to spawn in.
    pub working_dir: Option<String>,
}

/// Why an entry was skipped. Kept as a type rather than a bool so a scan can
/// report "48 entries, 12 hidden" instead of silently shrinking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skipped {
    /// `Type` is not `Application` — a Link or Directory entry.
    NotAnApplication,
    /// `NoDisplay=true` or `Hidden=true`.
    Hidden,
    /// `OnlyShowIn`/`NotShowIn` exclude us.
    WrongDesktop,
    /// No `Exec`, so there is nothing to launch.
    NoExec,
    /// Malformed enough that no `[Desktop Entry]` group was found.
    Malformed,
}

/// Environment a scan runs in. Passed explicitly so tests do not depend on the
/// machine running them.
#[derive(Debug, Clone)]
pub struct ParseContext {
    /// Preferred locales, most specific first (e.g. `["de_DE", "de"]`).
    pub locales: Vec<String>,
    /// What we claim `XDG_CURRENT_DESKTOP` is.
    pub desktop: String,
}

impl Default for ParseContext {
    fn default() -> Self {
        Self {
            locales: Vec::new(),
            desktop: "Infrawrench".to_owned(),
        }
    }
}

impl ParseContext {
    /// Derive locale preferences from the usual environment variables, in the
    /// order the spec gives them.
    pub fn from_env() -> Self {
        let raw = std::env::var("LC_MESSAGES")
            .or_else(|_| std::env::var("LC_ALL"))
            .or_else(|_| std::env::var("LANG"))
            .unwrap_or_default();
        Self {
            locales: locale_candidates(&raw),
            desktop: "Infrawrench".to_owned(),
        }
    }
}

/// `de_DE.UTF-8@euro` → `["de_DE@euro", "de_DE", "de@euro", "de"]`, most
/// specific first, encoding dropped (the spec says to ignore it).
pub fn locale_candidates(raw: &str) -> Vec<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "C" || raw == "POSIX" {
        return Vec::new();
    }
    let (head, modifier) = match raw.split_once('@') {
        Some((h, m)) => (h, Some(m)),
        None => (raw, None),
    };
    let head = head.split('.').next().unwrap_or(head);
    let (lang, country) = match head.split_once('_') {
        Some((l, c)) => (l, Some(c)),
        None => (head, None),
    };

    let mut out = Vec::new();
    if let (Some(country), Some(modifier)) = (country, modifier) {
        out.push(format!("{lang}_{country}@{modifier}"));
    }
    if let Some(country) = country {
        out.push(format!("{lang}_{country}"));
    }
    if let Some(modifier) = modifier {
        out.push(format!("{lang}@{modifier}"));
    }
    out.push(lang.to_owned());
    out
}

/// Parse the `[Desktop Entry]` group of a `.desktop` file.
pub fn parse_entry(text: &str, id: &str, ctx: &ParseContext) -> Result<DesktopEntry, Skipped> {
    let mut keys: HashMap<String, String> = HashMap::new();
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            // Actions and other groups are out of scope for v1; stop at the
            // first group after ours rather than mixing their keys in.
            in_group = line == "[Desktop Entry]";
            if !in_group && !keys.is_empty() {
                break;
            }
            continue;
        }
        if !in_group {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            keys.entry(key.trim().to_owned())
                .or_insert_with(|| value.trim().to_owned());
        }
    }

    if keys.is_empty() {
        return Err(Skipped::Malformed);
    }
    if keys.get("Type").map(String::as_str) != Some("Application") {
        return Err(Skipped::NotAnApplication);
    }
    if is_true(keys.get("NoDisplay")) || is_true(keys.get("Hidden")) {
        return Err(Skipped::Hidden);
    }
    if let Some(only) = keys.get("OnlyShowIn")
        && !parse_list(only).iter().any(|d| d == &ctx.desktop)
    {
        return Err(Skipped::WrongDesktop);
    }
    if let Some(not) = keys.get("NotShowIn")
        && parse_list(not).iter().any(|d| d == &ctx.desktop)
    {
        return Err(Skipped::WrongDesktop);
    }
    let exec = keys.get("Exec").cloned().ok_or(Skipped::NoExec)?;
    if exec.trim().is_empty() {
        return Err(Skipped::NoExec);
    }

    let name = localised(&keys, "Name", ctx)
        .map(|v| unescape(&v))
        .unwrap_or_else(|| id.trim_end_matches(".desktop").to_owned());

    Ok(DesktopEntry {
        id: id.to_owned(),
        name,
        comment: localised(&keys, "Comment", ctx).map(|v| unescape(&v)),
        exec: unescape(&exec),
        icon: keys
            .get("Icon")
            .map(|v| unescape(v))
            .filter(|v| !v.is_empty()),
        categories: keys
            .get("Categories")
            .map(|v| parse_list(v))
            .unwrap_or_default(),
        terminal: is_true(keys.get("Terminal")),
        wm_class: keys.get("StartupWMClass").map(|v| unescape(v)),
        working_dir: keys
            .get("Path")
            .map(|v| unescape(v))
            .filter(|v| !v.is_empty()),
    })
}

/// `TryExec` names a binary that must exist for the entry to be installed.
pub fn try_exec_key(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("TryExec=") {
            return Some(unescape(rest.trim()));
        }
    }
    None
}

fn is_true(value: Option<&String>) -> bool {
    value.map(String::as_str) == Some("true")
}

fn localised(keys: &HashMap<String, String>, key: &str, ctx: &ParseContext) -> Option<String> {
    for locale in &ctx.locales {
        if let Some(value) = keys.get(&format!("{key}[{locale}]")) {
            return Some(value.clone());
        }
    }
    keys.get(key).cloned()
}

/// Semicolon-separated list, honouring `\;` as a literal semicolon.
pub fn parse_list(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            if ch != ';' {
                current.push('\\');
            }
            current.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == ';' {
            if !current.is_empty() {
                out.push(unescape(&current));
            }
            current.clear();
        } else {
            current.push(ch);
        }
    }
    if !current.trim().is_empty() {
        out.push(unescape(&current));
    }
    out
}

/// Resolve the spec's value escapes (`\s \n \t \r \\`).
pub fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Split an `Exec` value into argv, honouring the spec's quoting and dropping
/// every field code.
///
/// We pass no files or URLs, so `%f`/`%F`/`%u`/`%U` become nothing rather than
/// an empty string argument — an app that gets `""` where it expected a path
/// opens a file called "" and shows an error dialog.
pub fn exec_argv(exec: &str, entry_name: &str, icon: Option<&str>) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_current = false;
    let mut quoted = false;
    let mut chars = exec.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                quoted = !quoted;
                has_current = true;
            }
            '\\' if quoted => {
                // Inside quotes the spec reserves \\ \" \` \$; anything else
                // keeps its backslash.
                match chars.next() {
                    Some(next @ ('\\' | '"' | '`' | '$')) => current.push(next),
                    Some(other) => {
                        current.push('\\');
                        current.push(other);
                    }
                    None => current.push('\\'),
                }
                has_current = true;
            }
            ' ' | '\t' if !quoted => {
                if has_current {
                    argv.push(std::mem::take(&mut current));
                    has_current = false;
                }
            }
            '%' => match chars.next() {
                Some('%') => {
                    current.push('%');
                    has_current = true;
                }
                Some('i') => {
                    // Expands to two arguments, or to nothing without an icon.
                    if has_current {
                        argv.push(std::mem::take(&mut current));
                        has_current = false;
                    }
                    if let Some(icon) = icon {
                        argv.push("--icon".to_owned());
                        argv.push(icon.to_owned());
                    }
                }
                Some('c') => {
                    current.push_str(entry_name);
                    has_current = true;
                }
                // Every other code expands to files, URLs or deprecated
                // values we do not supply, so it contributes nothing — and a
                // bare "%U" argument disappears entirely rather than becoming
                // an empty string.
                Some(_) => {}
                None => {}
            },
            other => {
                current.push(other);
                has_current = true;
            }
        }
    }
    if has_current {
        argv.push(current);
    }
    argv.retain(|arg| !arg.is_empty());
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX: &str = "\
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox
Name[de]=Feuerfuchs
GenericName=Web Browser
Comment=Browse the World Wide Web
Exec=/usr/lib/firefox/firefox %u
Icon=firefox
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=firefox

[Desktop Action new-window]
Name=Open a New Window
Exec=/usr/lib/firefox/firefox --new-window
";

    fn ctx() -> ParseContext {
        ParseContext::default()
    }

    #[test]
    fn parses_a_realistic_entry() {
        let e = parse_entry(FIREFOX, "firefox.desktop", &ctx()).unwrap();
        assert_eq!(e.name, "Firefox");
        assert_eq!(e.comment.as_deref(), Some("Browse the World Wide Web"));
        assert_eq!(e.icon.as_deref(), Some("firefox"));
        assert_eq!(e.categories, vec!["Network", "WebBrowser"]);
        assert_eq!(e.wm_class.as_deref(), Some("firefox"));
        assert!(!e.terminal);
    }

    #[test]
    fn does_not_absorb_keys_from_action_groups() {
        // The action group's Name and Exec must not overwrite the entry's.
        let e = parse_entry(FIREFOX, "firefox.desktop", &ctx()).unwrap();
        assert_eq!(e.name, "Firefox");
        assert_eq!(e.exec, "/usr/lib/firefox/firefox %u");
    }

    #[test]
    fn prefers_the_most_specific_locale() {
        let ctx = ParseContext {
            locales: locale_candidates("de_DE.UTF-8"),
            ..ParseContext::default()
        };
        let e = parse_entry(FIREFOX, "firefox.desktop", &ctx).unwrap();
        assert_eq!(e.name, "Feuerfuchs");
    }

    #[test]
    fn locale_candidates_are_ordered_most_specific_first() {
        assert_eq!(
            locale_candidates("sr_RS.UTF-8@latin"),
            vec!["sr_RS@latin", "sr_RS", "sr@latin", "sr"]
        );
        assert!(locale_candidates("C").is_empty());
        assert!(locale_candidates("").is_empty());
    }

    #[test]
    fn skips_entries_that_should_not_be_listed() {
        let cases = [
            (
                "[Desktop Entry]\nType=Link\nName=x\nURL=http://x\n",
                Skipped::NotAnApplication,
            ),
            (
                "[Desktop Entry]\nType=Application\nName=x\nExec=x\nNoDisplay=true\n",
                Skipped::Hidden,
            ),
            (
                "[Desktop Entry]\nType=Application\nName=x\nExec=x\nHidden=true\n",
                Skipped::Hidden,
            ),
            (
                "[Desktop Entry]\nType=Application\nName=x\n",
                Skipped::NoExec,
            ),
            ("nonsense\n", Skipped::Malformed),
        ];
        for (text, expected) in cases {
            assert_eq!(parse_entry(text, "x.desktop", &ctx()), Err(expected));
        }
    }

    #[test]
    fn honours_show_in_lists() {
        let only_gnome = "[Desktop Entry]\nType=Application\nName=x\nExec=x\nOnlyShowIn=GNOME;\n";
        assert_eq!(
            parse_entry(only_gnome, "x.desktop", &ctx()),
            Err(Skipped::WrongDesktop)
        );

        let not_us = "[Desktop Entry]\nType=Application\nName=x\nExec=x\nNotShowIn=Infrawrench;\n";
        assert_eq!(
            parse_entry(not_us, "x.desktop", &ctx()),
            Err(Skipped::WrongDesktop)
        );

        let only_us =
            "[Desktop Entry]\nType=Application\nName=x\nExec=x\nOnlyShowIn=Infrawrench;\n";
        assert!(parse_entry(only_us, "x.desktop", &ctx()).is_ok());
    }

    #[test]
    fn falls_back_to_the_id_when_a_name_is_missing() {
        let e = parse_entry(
            "[Desktop Entry]\nType=Application\nExec=htop\n",
            "htop.desktop",
            &ctx(),
        )
        .unwrap();
        assert_eq!(e.name, "htop");
    }

    #[test]
    fn unescapes_values() {
        assert_eq!(unescape(r"a\sb\nc\\d"), "a b\nc\\d");
        assert_eq!(unescape(r"trailing\"), r"trailing\");
        assert_eq!(unescape(r"\q"), r"\q");
    }

    #[test]
    fn parses_lists_with_escaped_semicolons() {
        assert_eq!(parse_list("A;B;"), vec!["A", "B"]);
        assert_eq!(parse_list(r"A\;B;C;"), vec!["A;B", "C"]);
        assert!(parse_list("").is_empty());
    }

    #[test]
    fn strips_field_codes_from_exec() {
        assert_eq!(
            exec_argv("/usr/lib/firefox/firefox %u", "Firefox", None),
            vec!["/usr/lib/firefox/firefox"]
        );
        assert_eq!(exec_argv("gimp-2.10 %U", "GIMP", None), vec!["gimp-2.10"]);
        assert_eq!(
            exec_argv("env FOO=1 code --unity-launch %F", "Code", None),
            vec!["env", "FOO=1", "code", "--unity-launch"]
        );
    }

    #[test]
    fn keeps_a_literal_percent() {
        assert_eq!(exec_argv("cmd 100%%", "x", None), vec!["cmd", "100%"]);
    }

    #[test]
    fn expands_the_name_and_icon_codes() {
        assert_eq!(exec_argv("cmd %c", "My App", None), vec!["cmd", "My App"]);
        assert_eq!(
            exec_argv("cmd %i rest", "x", Some("gimp")),
            vec!["cmd", "--icon", "gimp", "rest"]
        );
        assert_eq!(exec_argv("cmd %i rest", "x", None), vec!["cmd", "rest"]);
    }

    #[test]
    fn honours_quoting() {
        assert_eq!(
            exec_argv(r#""/opt/My App/bin/app" --flag "two words""#, "x", None),
            vec!["/opt/My App/bin/app", "--flag", "two words"]
        );
        assert_eq!(
            exec_argv(r#"sh -c "echo \"hi\"""#, "x", None),
            vec!["sh", "-c", r#"echo "hi""#]
        );
    }

    #[test]
    fn an_empty_quoted_argument_survives_quoting_but_not_the_retain() {
        // "" as an argument is almost always an artefact of a stripped field
        // code, and passing it makes apps open a file named "".
        assert_eq!(exec_argv(r#"cmd "" %f"#, "x", None), vec!["cmd"]);
    }
}

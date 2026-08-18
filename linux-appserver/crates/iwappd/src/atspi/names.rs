//! The AT-SPI role and state vocabularies, by wire value.
//!
//! Transcribed from `atspi-constants.h` in at-spi2-core (`AtspiRole`,
//! `AtspiStateType`) — the numbers are the protocol, the names are ours to
//! phrase, so they are the traditional lowercase forms a screen-reader user
//! would recognise. An unknown value degrades to `role-<n>` / `state-<n>`
//! rather than being dropped: a newer toolkit's new role is still a node.

/// `AtspiRole`, in order from 0.
const ROLES: &[&str] = &[
    "invalid",
    "accelerator label",
    "alert",
    "animation",
    "arrow",
    "calendar",
    "canvas",
    "check box",
    "check menu item",
    "color chooser",
    "column header",
    "combo box",
    "date editor",
    "desktop icon",
    "desktop frame",
    "dial",
    "dialog",
    "directory pane",
    "drawing area",
    "file chooser",
    "filler",
    "focus traversable",
    "font chooser",
    "frame",
    "glass pane",
    "html container",
    "icon",
    "image",
    "internal frame",
    "label",
    "layered pane",
    "list",
    "list item",
    "menu",
    "menu bar",
    "menu item",
    "option pane",
    "page tab",
    "page tab list",
    "panel",
    "password text",
    "popup menu",
    "progress bar",
    "push button",
    "radio button",
    "radio menu item",
    "root pane",
    "row header",
    "scroll bar",
    "scroll pane",
    "separator",
    "slider",
    "spin button",
    "split pane",
    "status bar",
    "table",
    "table cell",
    "table column header",
    "table row header",
    "tearoff menu item",
    "terminal",
    "text",
    "toggle button",
    "tool bar",
    "tool tip",
    "tree",
    "tree table",
    "unknown",
    "viewport",
    "window",
    "extended",
    "header",
    "footer",
    "paragraph",
    "ruler",
    "application",
    "autocomplete",
    "edit bar",
    "embedded",
    "entry",
    "chart",
    "caption",
    "document frame",
    "heading",
    "page",
    "section",
    "redundant object",
    "form",
    "link",
    "input method window",
    "table row",
    "tree item",
    "document spreadsheet",
    "document presentation",
    "document text",
    "document web",
    "document email",
    "comment",
    "list box",
    "grouping",
    "image map",
    "notification",
    "info bar",
    "level bar",
    "title bar",
    "block quote",
    "audio",
    "video",
    "definition",
    "article",
    "landmark",
    "log",
    "marquee",
    "math",
    "rating",
    "timer",
    "static",
    "math fraction",
    "math root",
    "subscript",
    "superscript",
    "description list",
    "description term",
    "description value",
    "footnote",
    "content deletion",
    "content insertion",
    "mark",
    "suggestion",
    "push button menu",
    "switch",
];

/// `AtspiStateType`, in order from 0.
const STATES: &[&str] = &[
    "invalid",
    "active",
    "armed",
    "busy",
    "checked",
    "collapsed",
    "defunct",
    "editable",
    "enabled",
    "expandable",
    "expanded",
    "focusable",
    "focused",
    "has tooltip",
    "horizontal",
    "iconified",
    "modal",
    "multi line",
    "multiselectable",
    "opaque",
    "pressed",
    "resizable",
    "selectable",
    "selected",
    "sensitive",
    "showing",
    "single line",
    "stale",
    "transient",
    "vertical",
    "visible",
    "manages descendants",
    "indeterminate",
    "required",
    "truncated",
    "animated",
    "invalid entry",
    "supports autocompletion",
    "selectable text",
    "is default",
    "visited",
    "checkable",
    "has popup",
    "read only",
];

pub fn role_name(value: u32) -> String {
    match ROLES.get(value as usize) {
        Some(name) => (*name).to_owned(),
        None => format!("role-{value}"),
    }
}

/// The state names set in an AT-SPI two-word bitfield, minus the ones that are
/// on for practically every healthy widget (`enabled`, `sensitive`, `opaque`)
/// — their *absence* still shows, as `visible`/`showing` do for hidden nodes.
pub fn state_names(low: u32, high: u32) -> Vec<String> {
    const ELIDED: &[&str] = &["enabled", "sensitive", "opaque"];
    let bits = u64::from(low) | (u64::from(high) << 32);
    let mut names = Vec::new();
    for index in 0..64 {
        if bits & (1 << index) == 0 {
            continue;
        }
        let name = match STATES.get(index as usize) {
            Some(name) => (*name).to_owned(),
            None => format!("state-{index}"),
        };
        if ELIDED.contains(&name.as_str()) {
            continue;
        }
        names.push(name);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_landmarks_of_the_role_table_are_where_the_header_says() {
        assert_eq!(role_name(0), "invalid");
        assert_eq!(role_name(23), "frame");
        assert_eq!(role_name(43), "push button");
        assert_eq!(role_name(61), "text");
        assert_eq!(role_name(79), "entry");
        assert_eq!(role_name(130), "switch");
        assert_eq!(role_name(131), "role-131");
    }

    #[test]
    fn states_decode_across_both_words_and_elide_the_constant_ones() {
        // enabled(8) + sensitive(24) + showing(25) + visible(30) + focused(12)
        // + read only(43, in the high word).
        let low = (1 << 8) | (1 << 24) | (1 << 25) | (1 << 30) | (1 << 12);
        let high = 1 << (43 - 32);
        assert_eq!(
            state_names(low, high),
            vec!["focused", "showing", "visible", "read only"]
        );
    }
}

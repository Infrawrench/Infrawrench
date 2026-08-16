//! The desktop-file flavour of INI, shared by `index.theme` parsing.
//!
//! Groups keep their order (icon themes list directories in preference order)
//! and duplicate keys resolve first-wins, which is what the spec says.

use std::collections::HashMap;

/// Parse into `(group name, keys)` pairs, in file order.
pub fn parse_ini(text: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut groups: Vec<(String, HashMap<String, String>)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            groups.push((name.trim().to_owned(), HashMap::new()));
            continue;
        }
        let Some((_, keys)) = groups.last_mut() else {
            // Keys before any group header are not addressable; the spec calls
            // the file invalid, and dropping them is the least surprising
            // reading of a file someone hand-edited.
            continue;
        };
        if let Some((key, value)) = line.split_once('=') {
            keys.entry(key.trim().to_owned())
                .or_insert_with(|| value.trim().to_owned());
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_group_order_and_first_wins_on_duplicates() {
        let groups = parse_ini("# comment\n[One]\nA=1\nA=2\n\n[Two]\nB = 3 \n[One]\nC=4\n");
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].0, "One");
        assert_eq!(groups[0].1["A"], "1");
        assert_eq!(groups[1].1["B"], "3");
        assert_eq!(groups[2].1["C"], "4");
    }

    #[test]
    fn ignores_keys_before_any_group() {
        let groups = parse_ini("stray=1\n[G]\nA=2\n");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1["A"], "2");
    }

    #[test]
    fn a_value_may_contain_equals_signs() {
        let groups = parse_ini("[G]\nExec=env A=1 B=2 prog\n");
        assert_eq!(groups[0].1["Exec"], "env A=1 B=2 prog");
    }
}

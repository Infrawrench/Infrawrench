//! The classes a PHP file declares, found the way Composer's class map
//! generator finds them (`composer/class-map-generator`'s `PhpFileCleaner`
//! and `PhpFileParser`): strings, heredocs and comments are blanked out,
//! then `class`, `interface`, `trait` and `enum` declarations are read
//! under the `namespace` in force.

/// The fully qualified names declared in `source`, in order.
pub(crate) fn find_classes(source: &[u8]) -> Vec<String> {
    if !has_declaration_word(source) {
        return Vec::new();
    }
    let clean = clean(source);
    scan(&clean)
}

const TYPES: [&[u8]; 4] = [b"class", b"interface", b"trait", b"enum"];

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80
}

fn starts_with_ignore_case(s: &[u8], word: &[u8]) -> bool {
    s.len() >= word.len() && s[..word.len()].eq_ignore_ascii_case(word)
}

/// `\b(class|interface|trait|enum)\s`, case-insensitively: the generator's
/// early exit.
fn has_declaration_word(s: &[u8]) -> bool {
    (0..s.len()).any(|i| {
        (i == 0 || !is_word(s[i - 1]))
            && TYPES.iter().any(|w| {
                starts_with_ignore_case(&s[i..], w)
                    && s.get(i + w.len()).is_some_and(|c| c.is_ascii_whitespace())
            })
    })
}

/// PhpFileCleaner::clean on raw source: text outside `<?` ... `?>` is
/// dropped, strings and heredocs become `null`, comments disappear.
fn clean(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    let peek = |i: usize, c: u8| s.get(i + 1) == Some(&c);
    'outer: while i < s.len() {
        // Skip to the next `<?`.
        while i < s.len() {
            if s[i] == b'<' && peek(i, b'?') {
                i += 2;
                break;
            }
            i += 1;
        }
        out.extend_from_slice(b"<?");
        while i < s.len() {
            let c = s[i];
            if c == b'?' && peek(i, b'>') {
                out.extend_from_slice(b"?>");
                i += 2;
                continue 'outer;
            }
            if matches!(c, b'"' | b'\'' | b'`') {
                i = skip_string(s, i, c);
                out.extend_from_slice(b"null");
                continue;
            }
            if c == b'<'
                && peek(i, b'<')
                && let Some((len, delimiter)) = heredoc_start(&s[i..])
            {
                i = skip_heredoc(s, i + len, &delimiter);
                out.extend_from_slice(b"null");
                continue;
            }
            // `#[` is an attribute in PHP 8, not a comment.
            if c == b'#' && !peek(i, b'[') {
                i = skip_to_newline(s, i, true);
                continue;
            }
            if c == b'/' && peek(i, b'/') {
                i = skip_to_newline(s, i, true);
                continue;
            }
            if c == b'/' && peek(i, b'*') {
                i += 2;
                while i < s.len() && !(s[i] == b'*' && peek(i, b'/')) {
                    i += 1;
                }
                i = (i + 2).min(s.len());
                continue;
            }
            out.push(c);
            i += 1;
        }
    }
    out
}

fn skip_string(s: &[u8], mut i: usize, delimiter: u8) -> usize {
    i += 1;
    while i < s.len() {
        if s[i] == b'\\' && matches!(s.get(i + 1), Some(&n) if n == b'\\' || n == delimiter) {
            i += 2;
            continue;
        }
        if s[i] == delimiter {
            return i + 1;
        }
        i += 1;
    }
    i
}

/// A `#` or `//` comment ends at a line break or at `?>`.
fn skip_to_newline(s: &[u8], mut i: usize, php_comment: bool) -> usize {
    while i < s.len() {
        match s[i] {
            b'\r' | b'\n' => return i,
            b'?' if php_comment && s.get(i + 1) == Some(&b'>') => return i,
            _ => i += 1,
        }
    }
    i
}

/// `<<<[ \t]*(['"]?)NAME\1` and a line break: its length and NAME.
fn heredoc_start(s: &[u8]) -> Option<(usize, Vec<u8>)> {
    let mut i = 3;
    if !s.starts_with(b"<<<") {
        return None;
    }
    while matches!(s.get(i), Some(b' ' | b'\t')) {
        i += 1;
    }
    let quote = match s.get(i) {
        Some(&q @ (b'\'' | b'"')) => {
            i += 1;
            Some(q)
        }
        _ => None,
    };
    let start = i;
    if !s
        .get(i)
        .is_some_and(|&c| c.is_ascii_alphabetic() || c == b'_' || c >= 0x80)
    {
        return None;
    }
    while s.get(i).is_some_and(|&c| is_word(c)) {
        i += 1;
    }
    let name = s[start..i].to_vec();
    if let Some(q) = quote {
        if s.get(i) != Some(&q) {
            return None;
        }
        i += 1;
    }
    match s.get(i) {
        Some(b'\r') if s.get(i + 1) == Some(&b'\n') => Some((i + 2, name)),
        Some(b'\r' | b'\n') => Some((i + 1, name)),
        _ => None,
    }
}

/// Past the line that closes a heredoc: optional indentation, then the
/// delimiter not followed by a name character.
fn skip_heredoc(s: &[u8], mut i: usize, delimiter: &[u8]) -> usize {
    while i < s.len() {
        match s[i] {
            b' ' | b'\t' => {
                i += 1;
                continue;
            }
            _ if s[i..].starts_with(delimiter)
                && !s.get(i + delimiter.len()).is_some_and(|&c| is_word(c)) =>
            {
                return i + delimiter.len();
            }
            _ => {}
        }
        i = skip_to_newline(s, i, false);
        while matches!(s.get(i), Some(b'\r' | b'\n')) {
            i += 1;
        }
    }
    i
}

fn is_name_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x7f
}

fn is_name_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c >= 0x7f
}

/// PhpFileParser's declaration regex over cleaned source.
fn scan(s: &[u8]) -> Vec<String> {
    let mut classes = Vec::new();
    let mut namespace = String::new();
    let mut i = 0;
    while i < s.len() {
        // `\b(?<![\\$:>])` before the keyword.
        let boundary = i == 0 || !is_word(s[i - 1]);
        let allowed = i == 0 || !matches!(s[i - 1], b'\\' | b'$' | b':' | b'>');
        if !(boundary && allowed && s[i].is_ascii_alphabetic()) {
            i += 1;
            continue;
        }
        if starts_with_ignore_case(&s[i..], b"namespace")
            && !s.get(i + 9).is_some_and(|&c| is_word(c))
            && let Some((name, end)) = namespace_declaration(s, i + 9)
        {
            namespace = if name.is_empty() {
                String::new()
            } else {
                format!("{name}\\")
            };
            i = end;
            continue;
        }
        let keyword = TYPES.iter().find(|w| {
            starts_with_ignore_case(&s[i..], w)
                && s.get(i + w.len()).is_some_and(|c| c.is_ascii_whitespace())
        });
        let Some(keyword) = keyword else {
            // Skip the rest of this word.
            while i < s.len() && is_word(s[i]) {
                i += 1;
            }
            continue;
        };
        let mut j = i + keyword.len();
        while s.get(j).is_some_and(|c| c.is_ascii_whitespace()) {
            j += 1;
        }
        let start = j;
        if s.get(j).is_some_and(|&c| is_name_start(c) || c == b':') {
            j += 1;
            while s
                .get(j)
                .is_some_and(|&c| is_name_char(c) || c == b':' || c == b'-')
            {
                j += 1;
            }
        }
        if j == start {
            i = j;
            continue;
        }
        let mut name = String::from_utf8_lossy(&s[start..j]).into_owned();
        i = j;
        if name == "extends" || name == "implements" {
            continue;
        }
        if let Some(xhp) = name.strip_prefix(':') {
            name = format!("xhp{}", xhp.replace('-', "_").replace(':', "__"));
        } else if keyword.eq_ignore_ascii_case(b"enum")
            && let Some(colon) = name.rfind(':')
        {
            name.truncate(colon);
        }
        let full = format!("{namespace}{name}");
        classes.push(full.trim_start_matches('\\').to_string());
    }
    classes
}

/// After `namespace`: an optional name (`A\B`, whitespace allowed around
/// the separators) and then `{` or `;`. The name and where scanning goes
/// on, or `None` when this is not a declaration (`namespace\foo()`).
fn namespace_declaration(s: &[u8], mut i: usize) -> Option<(String, usize)> {
    let mut name = String::new();
    let ws = |i: &mut usize| {
        while s.get(*i).is_some_and(|c| c.is_ascii_whitespace()) {
            *i += 1;
        }
    };
    let had_space = s.get(i).is_some_and(|c| c.is_ascii_whitespace());
    ws(&mut i);
    if had_space && s.get(i).is_some_and(|&c| is_name_start(c)) {
        loop {
            let start = i;
            while s.get(i).is_some_and(|&c| is_name_char(c)) {
                i += 1;
            }
            name.push_str(&String::from_utf8_lossy(&s[start..i]));
            let mut k = i;
            ws(&mut k);
            if s.get(k) == Some(&b'\\') {
                k += 1;
                ws(&mut k);
                if s.get(k).is_some_and(|&c| is_name_start(c)) {
                    name.push('\\');
                    i = k;
                    continue;
                }
            }
            break;
        }
        ws(&mut i);
    }
    matches!(s.get(i), Some(b'{' | b';')).then_some((name, i + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(source: &str) -> Vec<String> {
        find_classes(source.as_bytes())
    }

    #[test]
    fn declarations_under_namespaces() {
        let source = r#"<?php
namespace Foo\Bar;

/** class NotInComment {} */
// class AlsoNot
# class NorThis
#[Attribute]
final class Baz extends Base implements I {}
abstract class Qux {}
interface Thing {}
trait Helps {}
enum Suit: string { case Hearts = 'h'; }
$x = Baz::class;
$y = new class extends Base {};
$s = "class InString {}";
$h = <<<EOT
class InHeredoc {}
EOT;
$n = <<<'EOT'
  class InNowdoc {}
  EOT;
namespace Other { class Last {} }
"#;
        assert_eq!(
            find(source),
            [
                "Foo\\Bar\\Baz",
                "Foo\\Bar\\Qux",
                "Foo\\Bar\\Thing",
                "Foo\\Bar\\Helps",
                "Foo\\Bar\\Suit",
                "Other\\Last"
            ]
        );
    }

    #[test]
    fn html_and_files_without_classes() {
        assert!(find("<?php function f() {}\n").is_empty());
        assert_eq!(
            find("<p>class Html {}</p><?php class Real {} ?> class After {}"),
            ["Real"]
        );
        assert_eq!(find("<?php\nnamespace A\\B ;\nclass C {}\n"), ["A\\B\\C"]);
        assert_eq!(find("<?php\nnamespace {\nclass Root {}\n}\n"), ["Root"]);
        assert_eq!(find("<?php\n$a = namespace\\f();\nclass D {}\n"), ["D"]);
        assert_eq!(find("<?php\nenum E:int { }\n"), ["E"]);
    }
}

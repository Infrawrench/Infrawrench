//! A strict applier for the git-style unified diffs `pnpm patch-commit`
//! writes.
//!
//! Strict means every context and removed line must match the file
//! exactly, at the position the hunk header gives (shifted only by what
//! earlier hunks in the same file added or removed). There is no fuzz and
//! no searching for a nearby match: a patch that does not apply cleanly is
//! a patch written against different package contents, and silently
//! applying it somewhere else would type-check code against files nobody
//! reviewed.
//!
//! Lines are split on `\n` alone, so a `\r` stays part of the line on both
//! sides and patches of CRLF files apply byte for byte.

use std::collections::BTreeMap;

/// A parsed patch: the files it touches, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    files: Vec<FilePatch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FilePatch {
    /// `None` for a created file (`--- /dev/null`).
    old_path: Option<String>,
    /// `None` for a deleted file (`+++ /dev/null`).
    new_path: Option<String>,
    hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Hunk {
    old_start: usize,
    old_len: usize,
    lines: Vec<Line>,
    /// `\ No newline at end of file` after the old side's last line.
    old_no_newline: bool,
    /// The same for the new side.
    new_no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Line {
    Context(Vec<u8>),
    Remove(Vec<u8>),
    Add(Vec<u8>),
}

impl Patch {
    /// Parses `text`. Anything that is not a well-formed text diff (binary
    /// patches, a hunk whose line counts do not add up) is an error.
    pub fn parse(text: &[u8]) -> Result<Patch, String> {
        Parser::new(text).parse()
    }

    /// Applies the patch to `files` (path relative to the package root to
    /// contents) in place.
    pub fn apply(&self, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
        for file in &self.files {
            file.apply(files)?;
        }
        Ok(())
    }
}

struct Parser<'a> {
    lines: Vec<&'a [u8]>,
    index: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a [u8]) -> Self {
        let mut lines: Vec<&[u8]> = text.split(|&b| b == b'\n').collect();
        // The piece after the final newline is not a line.
        if lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        Parser { lines, index: 0 }
    }

    fn parse(mut self) -> Result<Patch, String> {
        let mut files = Vec::new();
        let mut current: Option<FilePatch> = None;
        while self.index < self.lines.len() {
            let line = self.lines[self.index];
            let line_number = self.index + 1;
            self.index += 1;
            if let Some(rest) = line.strip_prefix(b"diff --git ") {
                files.extend(current.take());
                let (old, new) = split_git_header(rest)
                    .ok_or_else(|| format!("line {line_number}: unreadable diff header"))?;
                current = Some(FilePatch {
                    old_path: Some(old),
                    new_path: Some(new),
                    hunks: Vec::new(),
                });
            } else if line.starts_with(b"new file mode") {
                file_or_err(&mut current, line_number)?.old_path = None;
            } else if line.starts_with(b"deleted file mode") {
                file_or_err(&mut current, line_number)?.new_path = None;
            } else if let Some(rest) = line.strip_prefix(b"rename from ") {
                file_or_err(&mut current, line_number)?.old_path = Some(utf8(rest, line_number)?);
            } else if let Some(rest) = line.strip_prefix(b"rename to ") {
                file_or_err(&mut current, line_number)?.new_path = Some(utf8(rest, line_number)?);
            } else if line.starts_with(b"GIT binary patch") || line.starts_with(b"Binary files ") {
                return Err(format!(
                    "line {line_number}: binary patches are not supported"
                ));
            } else if let Some(rest) = line.strip_prefix(b"--- ") {
                // A plain diff (no `diff --git` line) starts each file here.
                if current.as_ref().is_none_or(|file| !file.hunks.is_empty()) {
                    files.extend(current.take());
                    current = Some(FilePatch {
                        old_path: None,
                        new_path: None,
                        hunks: Vec::new(),
                    });
                }
                file_or_err(&mut current, line_number)?.old_path = header_path(rest, line_number)?;
            } else if let Some(rest) = line.strip_prefix(b"+++ ") {
                file_or_err(&mut current, line_number)?.new_path = header_path(rest, line_number)?;
            } else if line.starts_with(b"@@ ") {
                let hunk = self.hunk(line, line_number)?;
                file_or_err(&mut current, line_number)?.hunks.push(hunk);
            }
            // Everything else between files (`index`, `similarity index`,
            // mode lines, commit text) carries nothing to apply.
        }
        files.extend(current);
        Ok(Patch { files })
    }

    fn hunk(&mut self, header: &[u8], line_number: usize) -> Result<Hunk, String> {
        let bad = || format!("line {line_number}: unreadable hunk header");
        let header = std::str::from_utf8(header).map_err(|_| bad())?;
        let mut parts = header.split(' ');
        let (Some("@@"), Some(old), Some(new)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(bad());
        };
        let (old_start, old_len) = range(old.strip_prefix('-').ok_or_else(bad)?).ok_or_else(bad)?;
        let (_, new_len) = range(new.strip_prefix('+').ok_or_else(bad)?).ok_or_else(bad)?;
        let mut hunk = Hunk {
            old_start,
            old_len,
            lines: Vec::new(),
            old_no_newline: false,
            new_no_newline: false,
        };
        let (mut old_left, mut new_left) = (old_len, new_len);
        while old_left > 0 || new_left > 0 {
            let Some(&line) = self.lines.get(self.index) else {
                return Err(format!("line {line_number}: hunk ends early"));
            };
            let number = self.index + 1;
            self.index += 1;
            let (kind, body) = match line.split_first() {
                Some((kind, body)) => (*kind, body),
                // Some editors strip the single space of an empty context
                // line; git accepts that and so does this.
                None => (b' ', &[][..]),
            };
            let entry = match kind {
                b' ' if old_left > 0 && new_left > 0 => {
                    old_left -= 1;
                    new_left -= 1;
                    Line::Context(body.to_vec())
                }
                b'-' if old_left > 0 => {
                    old_left -= 1;
                    Line::Remove(body.to_vec())
                }
                b'+' if new_left > 0 => {
                    new_left -= 1;
                    Line::Add(body.to_vec())
                }
                b'\\' => {
                    self.no_newline(&mut hunk);
                    continue;
                }
                _ => {
                    return Err(format!(
                        "line {number}: does not fit the hunk's line counts"
                    ));
                }
            };
            hunk.lines.push(entry);
        }
        if self
            .lines
            .get(self.index)
            .is_some_and(|line| line.starts_with(b"\\"))
        {
            self.index += 1;
            self.no_newline(&mut hunk);
        }
        Ok(hunk)
    }

    /// Records a `\ No newline at end of file` against the line before it.
    fn no_newline(&self, hunk: &mut Hunk) {
        match hunk.lines.last() {
            Some(Line::Remove(_)) => hunk.old_no_newline = true,
            Some(Line::Add(_)) => hunk.new_no_newline = true,
            Some(Line::Context(_)) => {
                hunk.old_no_newline = true;
                hunk.new_no_newline = true;
            }
            None => {}
        }
    }
}

fn file_or_err(
    current: &mut Option<FilePatch>,
    line_number: usize,
) -> Result<&mut FilePatch, String> {
    current
        .as_mut()
        .ok_or_else(|| format!("line {line_number}: outside any file"))
}

fn utf8(bytes: &[u8], line_number: usize) -> Result<String, String> {
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|_| format!("line {line_number}: path is not UTF-8"))
}

/// `a/x b/y` from a `diff --git` line. Paths with spaces are ambiguous
/// there; the `---`/`+++` lines that follow settle them.
fn split_git_header(rest: &[u8]) -> Option<(String, String)> {
    let rest = std::str::from_utf8(rest).ok()?;
    let (old, new) = rest.split_once(" b/")?;
    Some((strip_prefix_dir(old).to_string(), new.to_string()))
}

/// The path on a `---`/`+++` line: `None` for `/dev/null`, else without
/// the `a/` or `b/` prefix and any tab-separated timestamp.
fn header_path(rest: &[u8], line_number: usize) -> Result<Option<String>, String> {
    let rest = utf8(rest, line_number)?;
    let path = rest
        .split('\t')
        .next()
        .unwrap_or(&rest)
        .trim_end_matches('\r');
    if path == "/dev/null" {
        return Ok(None);
    }
    Ok(Some(strip_prefix_dir(path).to_string()))
}

fn strip_prefix_dir(path: &str) -> &str {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
}

/// `start,len` or `start` (a length of one).
fn range(text: &str) -> Option<(usize, usize)> {
    match text.split_once(',') {
        Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
        None => Some((text.parse().ok()?, 1)),
    }
}

/// A path from a patch, refused if it could leave the package directory.
fn checked(path: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(format!("{path}: leaves the package directory")),
            part => parts.push(part),
        }
    }
    if parts.is_empty() || path.starts_with('/') {
        return Err(format!("{path}: not a path inside the package"));
    }
    Ok(parts.join("/"))
}

impl FilePatch {
    fn apply(&self, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
        let old_path = self.old_path.as_deref().map(checked).transpose()?;
        let new_path = self.new_path.as_deref().map(checked).transpose()?;
        let original = match &old_path {
            Some(path) => Some(
                files
                    .get(path)
                    .ok_or_else(|| format!("{path}: not in the package"))?
                    .clone(),
            ),
            None => {
                if let Some(path) = &new_path
                    && files.contains_key(path)
                {
                    return Err(format!(
                        "{path}: created by the patch but already in the package"
                    ));
                }
                None
            }
        };
        let name = new_path.as_deref().or(old_path.as_deref()).unwrap_or("?");
        let patched = apply_hunks(original.as_deref().unwrap_or(b""), &self.hunks)
            .map_err(|message| format!("{name}: {message}"))?;
        if let Some(path) = &old_path {
            files.remove(path);
        }
        match new_path {
            Some(path) => {
                files.insert(path, patched);
            }
            None if !patched.is_empty() => {
                return Err(format!(
                    "{name}: deleted by the patch but not emptied by it"
                ));
            }
            None => {}
        }
        Ok(())
    }
}

fn apply_hunks(original: &[u8], hunks: &[Hunk]) -> Result<Vec<u8>, String> {
    if hunks.is_empty() {
        return Ok(original.to_vec());
    }
    let mut lines: Vec<&[u8]> = original.split(|&b| b == b'\n').collect();
    let mut trailing_newline = original.ends_with(b"\n");
    if trailing_newline || original.is_empty() {
        lines.pop();
    }
    let mut out: Vec<&[u8]> = Vec::with_capacity(lines.len());
    let mut cursor = 0usize;
    for (number, hunk) in hunks.iter().enumerate() {
        // `-N,0` inserts after line N; any other range starts at line N.
        let start = if hunk.old_len == 0 {
            hunk.old_start
        } else {
            hunk.old_start.saturating_sub(1)
        };
        if start < cursor || start > lines.len() {
            return Err(format!(
                "hunk {} starts at line {}, outside the file or before the previous hunk",
                number + 1,
                hunk.old_start
            ));
        }
        out.extend_from_slice(&lines[cursor..start]);
        let mut at = start;
        for line in &hunk.lines {
            match line {
                Line::Context(expected) | Line::Remove(expected) => {
                    if lines.get(at).copied() != Some(expected.as_slice()) {
                        return Err(format!(
                            "hunk {} does not match line {}",
                            number + 1,
                            at + 1
                        ));
                    }
                    if matches!(line, Line::Context(_)) {
                        out.push(lines[at]);
                    }
                    at += 1;
                }
                Line::Add(added) => out.push(added),
            }
        }
        if at == lines.len() && !lines.is_empty() && hunk.old_no_newline == trailing_newline {
            return Err(format!(
                "hunk {} disagrees with the file about its final newline",
                number + 1
            ));
        }
        if at == lines.len() {
            trailing_newline = !hunk.new_no_newline;
        }
        cursor = at;
    }
    out.extend_from_slice(&lines[cursor..]);
    let mut patched = out.join(&b'\n');
    if trailing_newline && !out.is_empty() {
        patched.push(b'\n');
    }
    Ok(patched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &[u8])]) -> BTreeMap<String, Vec<u8>> {
        entries
            .iter()
            .map(|(path, bytes)| (path.to_string(), bytes.to_vec()))
            .collect()
    }

    #[test]
    fn edits_creates_and_keeps_crlf() {
        let patch = b"diff --git a/lib/a.js b/lib/a.js
index 1111111..2222222 100644
--- a/lib/a.js
+++ b/lib/a.js
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -5,2 +5,3 @@
 five
 six
+seven
diff --git a/lib/b.d.ts b/lib/b.d.ts
--- a/lib/b.d.ts
+++ b/lib/b.d.ts
@@ -1,2 +1,2 @@
 export declare const v: string;\r
-export declare const m = \"7.1\";\r
+export declare const m = \"7.0\";\r
diff --git a/new.js b/new.js
new file mode 100644
--- /dev/null
+++ b/new.js
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
";
        let mut tree = files(&[
            ("lib/a.js", b"one\ntwo\nthree\nfour\nfive\nsix\n"),
            (
                "lib/b.d.ts",
                b"export declare const v: string;\r\nexport declare const m = \"7.1\";\r\n",
            ),
        ]);
        Patch::parse(patch).unwrap().apply(&mut tree).unwrap();
        assert_eq!(
            tree["lib/a.js"],
            b"one\nTWO\nthree\nfour\nfive\nsix\nseven\n"
        );
        assert_eq!(
            tree["lib/b.d.ts"],
            b"export declare const v: string;\r\nexport declare const m = \"7.0\";\r\n"
        );
        assert_eq!(tree["new.js"], b"hello\nworld");
    }

    #[test]
    fn a_hunk_that_does_not_match_fails() {
        let patch = b"--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
        let mut tree = files(&[("x.js", b"a\nB\n")]);
        let error = Patch::parse(patch).unwrap().apply(&mut tree).unwrap_err();
        assert!(error.contains("does not match line 2"), "{error}");
        let mut missing = files(&[]);
        assert!(Patch::parse(patch).unwrap().apply(&mut missing).is_err());
    }

    #[test]
    fn final_newlines_are_checked_and_changed() {
        let patch = b"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n";
        let mut tree = files(&[("x", b"a")]);
        Patch::parse(patch).unwrap().apply(&mut tree).unwrap();
        assert_eq!(tree["x"], b"a\n");
        // Applied again, the file already ends in a newline the patch says
        // is not there.
        assert!(Patch::parse(patch).unwrap().apply(&mut tree).is_err());
    }

    #[test]
    fn deletes_renames_and_escapes() {
        let delete = b"diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
        let rename = b"diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n";
        let mut tree = files(&[("gone.js", b"x\n"), ("old.js", b"keep\n")]);
        Patch::parse(delete).unwrap().apply(&mut tree).unwrap();
        Patch::parse(rename).unwrap().apply(&mut tree).unwrap();
        assert_eq!(tree, files(&[("new.js", b"keep\n")]));
        let escape = b"--- /dev/null\n+++ b/../../etc/x\n@@ -0,0 +1 @@\n+x\n";
        assert!(Patch::parse(escape).unwrap().apply(&mut tree).is_err());
        let binary = b"diff --git a/x.png b/x.png\nGIT binary patch\nliteral 1\n";
        assert!(Patch::parse(binary).is_err());
    }
}

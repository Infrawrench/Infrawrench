//! Branch and path globs (`main`, `release/*`, `app/packages/web/**`).
//! `*` stops at `/`, `**` crosses it, as in most CI systems.

pub(crate) fn compile(pattern: &str) -> Result<globset::GlobMatcher, globset::Error> {
    Ok(globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()?
        .compile_matcher())
}

pub(crate) fn any_match(patterns: &[String], candidate: &str) -> bool {
    patterns
        .iter()
        .filter_map(|p| compile(p).ok())
        .any(|m| m.is_match(candidate))
}

//! The `if:` expression language: deliberately small, and checked at parse
//! time so a typo fails the push rather than silently skipping a job.
//!
//! ```text
//! expr    := or
//! or      := and ( "||" and )*
//! and     := unary ( "&&" unary )*
//! unary   := "!" unary | compare
//! compare := primary ( ( "==" | "!=" ) primary )?
//! primary := string | "true" | "false" | name | call | "(" expr ")"
//! call    := ident "(" ( expr ( "," expr )* )? ")"
//! ```
//!
//! Values are strings and booleans. Comparison is on text, so
//! `needs.a.result == 'success'` and `true == 'true'` both hold. A string is
//! true when it is non-empty and not `false`, so an output of `false` reads
//! as false, which is what a script writing `changed=false` means.

use std::fmt;

/// A name an expression can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Name {
    NeedsResult {
        job: String,
    },
    NeedsOutput {
        job: String,
        output: String,
    },
    CommitSha,
    CommitShortSha,
    CommitBranch,
    RepoId,
    Event,
    /// The pipeline's `name:`.
    PipelineName,
    /// A pull request's number; empty for any other event.
    PullRequestNumber,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    Str(String),
    Bool(bool),
    Name(Name),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Eq(Box<Expr>, Box<Expr>),
    Ne(Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Func {
    Success,
    Failure,
    Always,
    Contains,
    StartsWith,
    EndsWith,
    Changed,
}

impl Func {
    fn parse(name: &str) -> Option<(Func, std::ops::RangeInclusive<usize>)> {
        Some(match name {
            "success" => (Func::Success, 0..=0),
            "failure" => (Func::Failure, 0..=0),
            "always" => (Func::Always, 0..=0),
            "contains" => (Func::Contains, 2..=2),
            "startsWith" => (Func::StartsWith, 2..=2),
            "endsWith" => (Func::EndsWith, 2..=2),
            "changed" => (Func::Changed, 1..=64),
            _ => return None,
        })
    }

    fn is_status(self) -> bool {
        matches!(self, Func::Success | Func::Failure | Func::Always)
    }
}

impl Expr {
    /// Whether the expression calls `success()`, `failure()` or
    /// `always()`. One that does not is read as `success() && (expr)`, as
    /// in other CI systems, so `if: needs.a.outputs.x == 'y'` still does not
    /// run after a failure.
    pub fn mentions_status(&self) -> bool {
        match self {
            Expr::Call(f, args) => f.is_status() || args.iter().any(Expr::mentions_status),
            Expr::Not(e) => e.mentions_status(),
            Expr::And(a, b) | Expr::Or(a, b) | Expr::Eq(a, b) | Expr::Ne(a, b) => {
                a.mentions_status() || b.mentions_status()
            }
            Expr::Str(_) | Expr::Bool(_) | Expr::Name(_) => false,
        }
    }

    /// Every name the expression reads, for checking against `needs:`.
    pub fn names(&self) -> Vec<&Name> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect<'a>(&'a self, out: &mut Vec<&'a Name>) {
        match self {
            Expr::Name(n) => out.push(n),
            Expr::Not(e) => e.collect(out),
            Expr::And(a, b) | Expr::Or(a, b) | Expr::Eq(a, b) | Expr::Ne(a, b) => {
                a.collect(out);
                b.collect(out);
            }
            Expr::Call(_, args) => args.iter().for_each(|a| a.collect(out)),
            Expr::Str(_) | Expr::Bool(_) => {}
        }
    }
}

/// Parses a dotted name, shared with `${{ }}` interpolation.
pub fn parse_name(text: &str) -> Result<Name, String> {
    let parts: Vec<&str> = text.split('.').collect();
    match parts.as_slice() {
        ["commit", "sha"] => Ok(Name::CommitSha),
        ["commit", "short-sha"] => Ok(Name::CommitShortSha),
        ["commit", "branch"] => Ok(Name::CommitBranch),
        ["repo", "id"] => Ok(Name::RepoId),
        ["event"] => Ok(Name::Event),
        ["pipeline", "name"] => Ok(Name::PipelineName),
        ["pull-request", "number"] => Ok(Name::PullRequestNumber),
        ["needs", job, "result"] => Ok(Name::NeedsResult {
            job: job.to_string(),
        }),
        ["needs", job, "outputs", output] => Ok(Name::NeedsOutput {
            job: job.to_string(),
            output: output.to_string(),
        }),
        _ => Err(format!(
            "unknown name `{text}`; available: `needs.<job>.result`, `needs.<job>.outputs.<name>`, `commit.sha`, `commit.short-sha`, `commit.branch`, `repo.id`, `event`, `pipeline.name`, `pull-request.number`"
        )),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Str(String),
    Ident(String),
    LParen,
    RParen,
    Comma,
    Not,
    And,
    Or,
    Eq,
    Ne,
}

fn tokenize(src: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\n' | '\r' => i += 1,
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma);
                i += 1;
            }
            '!' if chars.get(i + 1) == Some(&'=') => {
                tokens.push(Token::Ne);
                i += 2;
            }
            '!' => {
                tokens.push(Token::Not);
                i += 1;
            }
            '=' if chars.get(i + 1) == Some(&'=') => {
                tokens.push(Token::Eq);
                i += 2;
            }
            '&' if chars.get(i + 1) == Some(&'&') => {
                tokens.push(Token::And);
                i += 2;
            }
            '|' if chars.get(i + 1) == Some(&'|') => {
                tokens.push(Token::Or);
                i += 2;
            }
            '\'' | '"' => {
                // Quotes are doubled to escape, as in YAML single quotes.
                let quote = c;
                let mut s = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err("unclosed string".into()),
                        Some(&q) if q == quote && chars.get(i + 1) == Some(&quote) => {
                            s.push(quote);
                            i += 2;
                        }
                        Some(&q) if q == quote => {
                            i += 1;
                            break;
                        }
                        Some(&ch) => {
                            s.push(ch);
                            i += 1;
                        }
                    }
                }
                tokens.push(Token::Str(s));
            }
            c if c.is_ascii_alphanumeric() || c == '_' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '-' | '.'))
                {
                    i += 1;
                }
                tokens.push(Token::Ident(chars[start..i].iter().collect()));
            }
            other => return Err(format!("unexpected `{other}`")),
        }
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn eat(&mut self, t: &Token) -> bool {
        if self.peek() == Some(t) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn or(&mut self) -> Result<Expr, String> {
        let mut left = self.and()?;
        while self.eat(&Token::Or) {
            left = Expr::Or(Box::new(left), Box::new(self.and()?));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, String> {
        let mut left = self.unary()?;
        while self.eat(&Token::And) {
            left = Expr::And(Box::new(left), Box::new(self.unary()?));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        if self.eat(&Token::Not) {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        let left = self.primary()?;
        if self.eat(&Token::Eq) {
            return Ok(Expr::Eq(Box::new(left), Box::new(self.primary()?)));
        }
        if self.eat(&Token::Ne) {
            return Ok(Expr::Ne(Box::new(left), Box::new(self.primary()?)));
        }
        Ok(left)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        let token = self
            .tokens
            .get(self.pos)
            .cloned()
            .ok_or("the expression ends too early")?;
        self.pos += 1;
        match token {
            Token::Str(s) => Ok(Expr::Str(s)),
            Token::LParen => {
                let e = self.or()?;
                if !self.eat(&Token::RParen) {
                    return Err("missing `)`".into());
                }
                Ok(e)
            }
            Token::Ident(id) if id == "true" => Ok(Expr::Bool(true)),
            Token::Ident(id) if id == "false" => Ok(Expr::Bool(false)),
            Token::Ident(id) if self.peek() == Some(&Token::LParen) => {
                self.pos += 1;
                let (func, arity) = Func::parse(&id).ok_or_else(|| {
                    format!("unknown function `{id}`; available: success(), failure(), always(), contains(), startsWith(), endsWith(), changed()")
                })?;
                let mut args = Vec::new();
                if !self.eat(&Token::RParen) {
                    loop {
                        args.push(self.or()?);
                        if self.eat(&Token::RParen) {
                            break;
                        }
                        if !self.eat(&Token::Comma) {
                            return Err(format!("expected `,` or `)` in `{id}(...)`"));
                        }
                    }
                }
                if !arity.contains(&args.len()) {
                    return Err(format!(
                        "`{id}` takes {} argument(s), not {}",
                        describe(&arity),
                        args.len()
                    ));
                }
                if func == Func::Changed && !args.iter().all(|a| matches!(a, Expr::Str(_))) {
                    return Err("`changed()` takes path globs as string literals".into());
                }
                Ok(Expr::Call(func, args))
            }
            Token::Ident(id) => Ok(Expr::Name(parse_name(&id)?)),
            other => Err(format!("unexpected {}", token_text(&other))),
        }
    }
}

fn describe(r: &std::ops::RangeInclusive<usize>) -> String {
    if r.start() == r.end() {
        r.start().to_string()
    } else {
        format!("{} or more", r.start())
    }
}

fn token_text(t: &Token) -> &'static str {
    match t {
        Token::RParen => "`)`",
        Token::Comma => "`,`",
        Token::And => "`&&`",
        Token::Or => "`||`",
        Token::Eq => "`==`",
        Token::Ne => "`!=`",
        Token::Not => "`!`",
        Token::LParen => "`(`",
        Token::Str(_) | Token::Ident(_) => "value",
    }
}

/// Parses an `if:` value. A surrounding `${{ }}` is allowed and ignored, so
/// both `if: needs.a.result == 'success'` and the common
/// `if: ${{ ... }}` read the same.
pub fn parse(src: &str) -> Result<Expr, String> {
    let trimmed = src.trim();
    let inner = trimmed
        .strip_prefix("${{")
        .and_then(|s| s.strip_suffix("}}"))
        .unwrap_or(trimmed);
    let mut p = Parser {
        tokens: tokenize(inner)?,
        pos: 0,
    };
    if p.tokens.is_empty() {
        return Err("is empty".into());
    }
    let e = p.or()?;
    if p.pos != p.tokens.len() {
        return Err(format!(
            "unexpected {} after the expression",
            token_text(&p.tokens[p.pos])
        ));
    }
    Ok(e)
}

/// What a value of an expression is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Str(String),
    Bool(bool),
}

impl Value {
    fn truthy(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Str(s) => !s.is_empty() && s != "false",
        }
    }

    fn text(&self) -> String {
        match self {
            Value::Bool(b) => b.to_string(),
            Value::Str(s) => s.clone(),
        }
    }
}

/// What evaluating needs from the run.
pub trait Env {
    fn name(&self, name: &Name) -> String;
    /// Whether every job this one needs passed (a job skipped by its own
    /// `if:` or `paths:` counts as passing).
    fn all_needs_passed(&self) -> bool;
    /// Whether the commit touches any of these globs; true when the
    /// changed paths are not known.
    fn changed(&self, globs: &[String]) -> bool;
}

fn eval(e: &Expr, env: &dyn Env) -> Value {
    match e {
        Expr::Str(s) => Value::Str(s.clone()),
        Expr::Bool(b) => Value::Bool(*b),
        Expr::Name(n) => Value::Str(env.name(n)),
        Expr::Not(e) => Value::Bool(!eval(e, env).truthy()),
        Expr::And(a, b) => Value::Bool(eval(a, env).truthy() && eval(b, env).truthy()),
        Expr::Or(a, b) => Value::Bool(eval(a, env).truthy() || eval(b, env).truthy()),
        Expr::Eq(a, b) => Value::Bool(eval(a, env).text() == eval(b, env).text()),
        Expr::Ne(a, b) => Value::Bool(eval(a, env).text() != eval(b, env).text()),
        Expr::Call(f, args) => {
            let text = |i: usize| eval(&args[i], env).text();
            Value::Bool(match f {
                Func::Success => env.all_needs_passed(),
                Func::Failure => !env.all_needs_passed(),
                Func::Always => true,
                Func::Contains => {
                    let (haystack, needle) = (text(0), text(1));
                    // A JSON list (a matrix-style output) is searched by
                    // element; anything else as text.
                    match serde_json::from_str::<Vec<serde_json::Value>>(&haystack) {
                        Ok(items) => items.iter().any(|v| match v {
                            serde_json::Value::String(s) => *s == needle,
                            // A number or boolean element compares by its JSON text.
                            #[allow(clippy::cmp_owned)]
                            other => other.to_string() == needle,
                        }),
                        Err(_) => haystack.contains(&needle),
                    }
                }
                Func::StartsWith => text(0).starts_with(&text(1)),
                Func::EndsWith => text(0).ends_with(&text(1)),
                Func::Changed => {
                    let globs: Vec<String> = (0..args.len()).map(text).collect();
                    env.changed(&globs)
                }
            })
        }
    }
}

/// Whether a job whose `if:` is `condition` (or none) runs.
pub fn should_run(condition: Option<&Expr>, env: &dyn Env) -> bool {
    match condition {
        None => env.all_needs_passed(),
        Some(e) if e.mentions_status() => eval(e, env).truthy(),
        Some(e) => env.all_needs_passed() && eval(e, env).truthy(),
    }
}

impl fmt::Display for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Name::NeedsResult { job } => write!(f, "needs.{job}.result"),
            Name::NeedsOutput { job, output } => write!(f, "needs.{job}.outputs.{output}"),
            Name::CommitSha => f.write_str("commit.sha"),
            Name::CommitShortSha => f.write_str("commit.short-sha"),
            Name::CommitBranch => f.write_str("commit.branch"),
            Name::RepoId => f.write_str("repo.id"),
            Name::Event => f.write_str("event"),
            Name::PipelineName => f.write_str("pipeline.name"),
            Name::PullRequestNumber => f.write_str("pull-request.number"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestEnv {
        passed: bool,
    }

    impl Env for TestEnv {
        fn name(&self, name: &Name) -> String {
            match name {
                Name::NeedsResult { .. } => if self.passed { "success" } else { "failure" }.into(),
                Name::NeedsOutput { output, .. } if output == "list" => {
                    r#"["web","mobile"]"#.into()
                }
                Name::NeedsOutput { output, .. } if output == "flag" => "false".into(),
                Name::NeedsOutput { .. } => "yes".into(),
                Name::CommitBranch => "release/1.2".into(),
                Name::Event => "push".into(),
                _ => String::new(),
            }
        }
        fn all_needs_passed(&self) -> bool {
            self.passed
        }
        fn changed(&self, globs: &[String]) -> bool {
            globs.iter().any(|g| g.starts_with("app/"))
        }
    }

    fn run(src: &str, passed: bool) -> bool {
        should_run(Some(&parse(src).unwrap()), &TestEnv { passed })
    }

    #[test]
    fn evaluates() {
        assert!(run("needs.a.outputs.x == 'yes'", true));
        assert!(
            !run("needs.a.outputs.x == 'yes'", false),
            "implicit success()"
        );
        assert!(run("failure()", false));
        assert!(!run("failure()", true));
        assert!(run("always()", false));
        assert!(run("${{ always() && needs.a.result == 'failure' }}", false));
        assert!(
            !run("needs.a.outputs.flag", true),
            "the text `false` is false"
        );
        assert!(run("!needs.a.outputs.flag", true));
        assert!(run("contains(needs.a.outputs.list, 'web')", true));
        assert!(
            !run("contains(needs.a.outputs.list, 'we')", true),
            "a JSON list matches whole elements"
        );
        assert!(run("contains('abc', 'b')", true));
        assert!(run(
            "startsWith(commit.branch, 'release/') && event == \"push\"",
            true
        ));
        assert!(run("endsWith(commit.branch, '.2') || false", true));
        assert!(run("changed('docs/**', 'app/**')", true));
        assert!(!run("changed('docs/**')", true));
        assert!(run("(true || false) && !(false)", true));
        assert!(run("'it''s' == \"it's\"", true));
        assert!(run("true == 'true'", true));
    }

    #[test]
    fn rejects_bad_expressions() {
        for (src, needle) in [
            ("", "is empty"),
            ("needs.a", "unknown name"),
            ("secrets.TOKEN", "unknown name"),
            ("nope()", "unknown function"),
            ("contains('a')", "takes 2 argument"),
            ("changed(commit.branch)", "string literals"),
            ("(true", "missing `)`"),
            ("true true", "after the expression"),
            ("'open", "unclosed"),
            ("a = b", "unexpected `=`"),
            ("&&", "unexpected `&&`"),
        ] {
            let err = parse(src).unwrap_err();
            assert!(err.contains(needle), "{src:?}: {err}");
        }
    }
}

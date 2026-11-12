//! PEP 508 environment markers, evaluated for the interpreter a job runs.
//!
//! `requests==2.32.3 ; python_version >= "3.8"` and a lock's per-package
//! `marker` say which entries apply to which interpreter. The installer
//! evaluates them for `env:python` (see [`super::Target`]), so an entry for
//! Windows or an older Python is left out exactly as pip would leave it out
//! there.

use std::collections::BTreeMap;

use super::{normalise_name, pep440};

/// The values a marker can read.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    pub values: BTreeMap<&'static str, String>,
    /// pylock.toml's `extras` and `dependency_groups` sets.
    pub extras: Vec<String>,
    pub dependency_groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Str(String),
    Ident(String),
    Op(&'static str),
    Open,
    Close,
}

fn tokenize(text: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '(' {
            out.push(Token::Open);
            i += 1;
        } else if c == ')' {
            out.push(Token::Close);
            i += 1;
        } else if c == '"' || c == '\'' {
            let end = chars[i + 1..]
                .iter()
                .position(|&d| d == c)
                .ok_or("a string is not closed")?;
            out.push(Token::Str(chars[i + 1..i + 1 + end].iter().collect()));
            i += end + 2;
        } else if c.is_ascii_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '.'))
            {
                i += 1;
            }
            out.push(Token::Ident(chars[start..i].iter().collect()));
        } else {
            let rest: String = chars[i..chars.len().min(i + 3)].iter().collect();
            let op = ["===", "==", "!=", "<=", ">=", "~=", "<", ">"]
                .into_iter()
                .find(|op| rest.starts_with(op))
                .ok_or_else(|| format!("unexpected {c:?}"))?;
            out.push(Token::Op(op));
            i += op.len();
        }
    }
    Ok(out)
}

/// Whether `marker` holds in `env`. `extra` is the extra being evaluated
/// for, as for a dependency's `Requires-Dist`; `None` reads as no extra.
pub fn evaluate(marker: &str, env: &Environment, extra: Option<&str>) -> Result<bool, String> {
    let tokens = tokenize(marker).map_err(|e| format!("marker {marker:?}: {e}"))?;
    let mut parser = Parser {
        tokens: &tokens,
        at: 0,
        env,
        extra,
    };
    let value = parser.or().map_err(|e| format!("marker {marker:?}: {e}"))?;
    if parser.at != tokens.len() {
        return Err(format!("marker {marker:?}: unexpected text after the end"));
    }
    Ok(value)
}

struct Parser<'a> {
    tokens: &'a [Token],
    at: usize,
    env: &'a Environment,
    extra: Option<&'a str>,
}

enum Operand {
    Literal(String),
    Variable(&'static str),
}

impl Parser<'_> {
    fn keyword(&mut self, word: &str) -> bool {
        if matches!(self.tokens.get(self.at), Some(Token::Ident(w)) if w == word) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn or(&mut self) -> Result<bool, String> {
        let mut value = self.and()?;
        while self.keyword("or") {
            // Both sides are parsed whatever the first gave, so a malformed
            // right-hand side is reported rather than skipped.
            let right = self.and()?;
            value = value || right;
        }
        Ok(value)
    }

    fn and(&mut self) -> Result<bool, String> {
        let mut value = self.atom()?;
        while self.keyword("and") {
            let right = self.atom()?;
            value = value && right;
        }
        Ok(value)
    }

    fn atom(&mut self) -> Result<bool, String> {
        if self.tokens.get(self.at) == Some(&Token::Open) {
            self.at += 1;
            let value = self.or()?;
            if self.tokens.get(self.at) != Some(&Token::Close) {
                return Err("a `(` is not closed".to_string());
            }
            self.at += 1;
            return Ok(value);
        }
        let left = self.operand()?;
        let op = match self.tokens.get(self.at) {
            Some(Token::Op(op)) => {
                self.at += 1;
                *op
            }
            Some(Token::Ident(w)) if w == "in" => {
                self.at += 1;
                "in"
            }
            Some(Token::Ident(w)) if w == "not" => {
                self.at += 1;
                if !self.keyword("in") {
                    return Err("`not` without `in`".to_string());
                }
                "not in"
            }
            _ => return Err("expected a comparison".to_string()),
        };
        let right = self.operand()?;
        self.compare(left, op, right)
    }

    fn operand(&mut self) -> Result<Operand, String> {
        let token = self.tokens.get(self.at).ok_or("ends too soon")?;
        self.at += 1;
        match token {
            Token::Str(s) => Ok(Operand::Literal(s.clone())),
            Token::Ident(name) => variable(name)
                .map(Operand::Variable)
                .ok_or_else(|| format!("unknown variable `{name}`")),
            _ => Err("expected a value".to_string()),
        }
    }

    fn value(&self, operand: &Operand) -> String {
        match operand {
            Operand::Literal(s) => s.clone(),
            Operand::Variable("extra") => self.extra.unwrap_or("").to_string(),
            Operand::Variable(name) => self.env.values.get(name).cloned().unwrap_or_default(),
        }
    }

    fn compare(&self, left: Operand, op: &str, right: Operand) -> Result<bool, String> {
        // pylock.toml's sets: `"test" in extras`.
        for (name, set) in [
            ("extras", &self.env.extras),
            ("dependency_groups", &self.env.dependency_groups),
        ] {
            if matches!(right, Operand::Variable(n) if n == name) {
                let member = set
                    .iter()
                    .any(|e| normalise_name(e) == normalise_name(&self.value(&left)));
                return match op {
                    "in" => Ok(member),
                    "not in" => Ok(!member),
                    _ => Err(format!("`{name}` takes only `in` and `not in`")),
                };
            }
        }
        let is_extra = |o: &Operand| matches!(o, Operand::Variable("extra"));
        let (mut l, mut r) = (self.value(&left), self.value(&right));
        if is_extra(&left) || is_extra(&right) {
            // PEP 685: extras compare as normalised names.
            l = normalise_name(&l);
            r = normalise_name(&r);
        }
        Ok(match op {
            "in" => r.contains(&l),
            "not in" => !r.contains(&l),
            _ => match pep440::compare(&l, op, &r) {
                Some(result) if !is_extra(&left) && !is_extra(&right) => result,
                _ => match op {
                    "==" | "===" => l == r,
                    "!=" => l != r,
                    "<" => l < r,
                    "<=" => l <= r,
                    ">" => l > r,
                    ">=" => l >= r,
                    _ => return Err(format!("`{op}` needs versions, not {l:?} and {r:?}")),
                },
            },
        })
    }
}

/// The canonical name of a marker variable, legacy spellings included.
fn variable(name: &str) -> Option<&'static str> {
    Some(match name {
        "python_version" => "python_version",
        "python_full_version" => "python_full_version",
        "os_name" | "os.name" => "os_name",
        "sys_platform" | "sys.platform" => "sys_platform",
        "platform_release" => "platform_release",
        "platform_system" => "platform_system",
        "platform_version" | "platform.version" => "platform_version",
        "platform_machine" | "platform.machine" => "platform_machine",
        "platform_python_implementation"
        | "platform.python_implementation"
        | "python_implementation" => "platform_python_implementation",
        "implementation_name" => "implementation_name",
        "implementation_version" => "implementation_version",
        "extra" => "extra",
        "extras" => "extras",
        "dependency_groups" => "dependency_groups",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Environment {
        super::super::Target::default().environment()
    }

    fn eval(m: &str) -> bool {
        evaluate(m, &env(), None).unwrap()
    }

    #[test]
    fn versions_compare_as_versions() {
        assert!(eval("python_version >= '3.8'"));
        assert!(eval("python_version > '3.9'"));
        assert!(!eval("python_version < '3.10'"));
        assert!(eval("'3.9' < python_version"));
        assert!(eval("python_full_version >= '3.13.0'"));
    }

    #[test]
    fn platforms_and_logic() {
        assert!(!eval("sys_platform == 'win32'"));
        assert!(eval(
            "sys_platform != 'win32' and (os_name == 'posix' or os_name == 'nt')"
        ));
        assert!(!eval(
            "platform_system == 'Windows' or platform_system == 'Darwin'"
        ));
        assert!(eval("implementation_name == \"cpython\""));
        assert!(eval("'wasm' in platform_machine"));
    }

    #[test]
    fn extras() {
        assert!(!evaluate("extra == 'socks'", &env(), None).unwrap());
        assert!(evaluate("extra == 'SOCKS'", &env(), Some("socks")).unwrap());
        let mut e = env();
        e.extras = vec!["Test".into()];
        e.dependency_groups = vec!["dev".into()];
        assert!(evaluate("'test' in extras and 'dev' in dependency_groups", &e, None).unwrap());
        assert!(!evaluate("'docs' in extras", &e, None).unwrap());
    }

    #[test]
    fn malformed() {
        assert!(evaluate("python_version >=", &env(), None).is_err());
        assert!(evaluate("color == 'red'", &env(), None).is_err());
        assert!(evaluate("(os_name == 'posix'", &env(), None).is_err());
    }
}

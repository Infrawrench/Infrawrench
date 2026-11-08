//! Minimal ANSI styling, off when stdout is not a terminal or `NO_COLOR` is
//! set (https://no-color.org).

use std::io::IsTerminal;
use std::sync::OnceLock;

fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal())
}

fn paint(code: &str, text: &str) -> String {
    if enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn bold(text: &str) -> String {
    paint("1", text)
}
pub fn dim(text: &str) -> String {
    paint("2", text)
}
pub fn ok(text: &str) -> String {
    paint("32", text)
}
pub fn fail(text: &str) -> String {
    paint("31", text)
}
pub fn warn(text: &str) -> String {
    paint("33", text)
}

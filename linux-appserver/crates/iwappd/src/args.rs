//! Argument parsing, hand-rolled.
//!
//! Four flags do not justify a dependency in a binary we upload to other
//! people's machines.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Speak the protocol over stdin/stdout. The normal mode.
    Serve,
    /// Print the installed applications and exit — the mode `infrawrench apps
    /// list` uses over a plain SSH exec, with no session at all.
    ListApps {
        json: bool,
    },
    /// Print what this host can do and exit.
    Caps {
        json: bool,
    },
    /// Launch one application, screenshot its window a few times, and exit.
    /// A smoke test for the compositor that needs no client at the other end.
    Capture(Capture),
    Version,
    Help,
}

/// Options for [`Command::Capture`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    /// Desktop-file id to launch.
    pub app_id: Option<String>,
    /// Raw command to launch, when no desktop entry describes it.
    pub exec: Option<String>,
    /// Directory the PNGs are written to.
    pub out_dir: String,
    pub frames: u32,
    pub interval_ms: u64,
    pub width: u32,
    pub height: u32,
    /// Wheel notches to scroll between shots. Proves the input path end to end
    /// without a client at the other end of the protocol.
    pub scroll: i32,
}

impl Default for Capture {
    fn default() -> Self {
        Self {
            app_id: None,
            exec: None,
            out_dir: ".".to_owned(),
            frames: 4,
            interval_ms: 2_000,
            width: 1280,
            height: 800,
            scroll: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub command: Command,
    pub session_id: String,
    /// Exit after this long with no client and no windows. Zero disables it.
    pub idle_timeout_secs: u64,
    pub icon_size: u32,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            command: Command::Serve,
            session_id: "default".to_owned(),
            idle_timeout_secs: 30 * 60,
            icon_size: 48,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ArgsError {
    #[error("unknown option {0}")]
    Unknown(String),
    #[error("{0} needs a value")]
    MissingValue(String),
    #[error("{0} is not a number")]
    NotANumber(String),
}

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Result<Args, ArgsError> {
    let mut args = Args::default();
    let mut json = false;
    let mut capture = Capture::default();
    let mut capturing = false;
    let mut iter = argv.into_iter().peekable();

    while let Some(arg) = iter.next() {
        let mut value = |name: &str| -> Result<String, ArgsError> {
            iter.next()
                .ok_or_else(|| ArgsError::MissingValue(name.to_owned()))
        };
        match arg.as_str() {
            "--serve" => args.command = Command::Serve,
            "--list-apps" => args.command = Command::ListApps { json: false },
            "--caps" => args.command = Command::Caps { json: false },
            "--version" | "-V" => args.command = Command::Version,
            "--help" | "-h" => args.command = Command::Help,
            "--json" => json = true,
            "--capture" => capturing = true,
            "--app-id" => capture.app_id = Some(value("--app-id")?),
            "--exec" => capture.exec = Some(value("--exec")?),
            "--out" => capture.out_dir = value("--out")?,
            "--frames" => {
                let raw = value("--frames")?;
                capture.frames = raw
                    .parse()
                    .map_err(|_| ArgsError::NotANumber(raw.clone()))?;
            }
            "--scroll" => {
                let raw = value("--scroll")?;
                capture.scroll = raw
                    .parse()
                    .map_err(|_| ArgsError::NotANumber(raw.clone()))?;
            }
            "--interval" => {
                let raw = value("--interval")?;
                capture.interval_ms = raw
                    .parse()
                    .map_err(|_| ArgsError::NotANumber(raw.clone()))?;
            }
            "--size" => {
                let raw = value("--size")?;
                let (w, h) = raw
                    .split_once('x')
                    .ok_or_else(|| ArgsError::NotANumber(raw.clone()))?;
                capture.width = w.parse().map_err(|_| ArgsError::NotANumber(raw.clone()))?;
                capture.height = h.parse().map_err(|_| ArgsError::NotANumber(raw.clone()))?;
            }
            "--session-id" => args.session_id = value("--session-id")?,
            "--idle-timeout" => {
                let raw = value("--idle-timeout")?;
                args.idle_timeout_secs = raw
                    .parse()
                    .map_err(|_| ArgsError::NotANumber(raw.clone()))?;
            }
            "--icon-size" => {
                let raw = value("--icon-size")?;
                args.icon_size = raw
                    .parse()
                    .map_err(|_| ArgsError::NotANumber(raw.clone()))?;
            }
            other => return Err(ArgsError::Unknown(other.to_owned())),
        }
    }

    if capturing {
        args.command = Command::Capture(capture);
        return Ok(args);
    }

    if json {
        args.command = match args.command {
            Command::ListApps { .. } => Command::ListApps { json: true },
            Command::Caps { .. } => Command::Caps { json: true },
            other => other,
        };
    }
    Ok(args)
}

pub const HELP: &str = "\
iwappd — the Infrawrench remote application server

  iwappd [--serve] --session-id <id> [--idle-timeout <secs>] [--icon-size <px>]
  iwappd --list-apps [--json]
  iwappd --caps [--json]
  iwappd --capture (--app-id <id> | --exec <cmd>) [--out <dir>]
                   [--frames <n>] [--interval <ms>] [--size <WxH>] [--scroll <n>]
  iwappd --version

Run without arguments it speaks the Infrawrench app protocol over stdin and
stdout: it is meant to be exec'd over SSH by the Infrawrench desktop app or the
cloud backend, not started by hand.
";

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(args: &[&str]) -> Result<Args, ArgsError> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults_to_serving_over_stdio() {
        assert_eq!(parse_str(&[]).unwrap(), Args::default());
    }

    #[test]
    fn reads_the_session_options() {
        let args = parse_str(&[
            "--session-id",
            "abc",
            "--idle-timeout",
            "60",
            "--icon-size",
            "32",
        ])
        .unwrap();
        assert_eq!(args.session_id, "abc");
        assert_eq!(args.idle_timeout_secs, 60);
        assert_eq!(args.icon_size, 32);
    }

    #[test]
    fn json_applies_to_the_listing_commands() {
        assert_eq!(
            parse_str(&["--list-apps", "--json"]).unwrap().command,
            Command::ListApps { json: true }
        );
        assert_eq!(
            parse_str(&["--json", "--caps"]).unwrap().command,
            Command::Caps { json: true }
        );
        // --json on its own changes nothing about serving.
        assert_eq!(parse_str(&["--json"]).unwrap().command, Command::Serve);
    }

    #[test]
    fn reports_bad_input_rather_than_guessing() {
        assert_eq!(
            parse_str(&["--nope"]),
            Err(ArgsError::Unknown("--nope".into()))
        );
        assert_eq!(
            parse_str(&["--session-id"]),
            Err(ArgsError::MissingValue("--session-id".into()))
        );
        assert_eq!(
            parse_str(&["--idle-timeout", "soon"]),
            Err(ArgsError::NotANumber("soon".into()))
        );
    }

    #[test]
    fn capture_collects_its_own_options() {
        let args = parse_str(&[
            "--capture",
            "--exec",
            "firefox https://example.com",
            "--out",
            "/tmp/shots",
            "--frames",
            "6",
            "--interval",
            "1500",
            "--size",
            "1280x800",
        ])
        .unwrap();
        let Command::Capture(capture) = args.command else {
            panic!("expected capture");
        };
        assert_eq!(capture.exec.as_deref(), Some("firefox https://example.com"));
        assert_eq!(capture.out_dir, "/tmp/shots");
        assert_eq!(capture.frames, 6);
        assert_eq!(capture.interval_ms, 1500);
        assert_eq!((capture.width, capture.height), (1280, 800));
    }

    #[test]
    fn capture_beats_a_stray_json_flag() {
        // --json means nothing to capture; it must not turn it into a listing.
        let args = parse_str(&["--capture", "--app-id", "x.desktop", "--json"]).unwrap();
        assert!(matches!(args.command, Command::Capture(_)));
    }

    #[test]
    fn a_malformed_size_is_rejected() {
        assert!(matches!(
            parse_str(&["--capture", "--size", "big"]),
            Err(ArgsError::NotANumber(_))
        ));
    }

    #[test]
    fn idle_timeout_zero_disables_it() {
        assert_eq!(
            parse_str(&["--idle-timeout", "0"])
                .unwrap()
                .idle_timeout_secs,
            0
        );
    }
}

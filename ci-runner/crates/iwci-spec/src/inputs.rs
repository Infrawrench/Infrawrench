//! `on.manual` inputs: declared by the pipeline, given by whoever starts a
//! run by hand, and read as `${{ inputs.<name> }}`.
//!
//! An input is data from a person, not from the repository, so it is typed
//! and checked here before anything reads it, and [`crate::interp`] refuses
//! it wherever its text would become code (a `run:` script, a one-line
//! `args:`). A script reads it from a variable it was put in by `env:`.

use std::collections::BTreeMap;

use crate::{Event, InputKind, InputSpec, ManualTrigger, SpecError, raw};

/// The most inputs one pipeline may declare.
pub const MAX_INPUTS: usize = 32;
/// The largest one input's value may be.
pub const MAX_INPUT_BYTES: usize = 16 << 10;
/// The most options a `choice` input may have.
pub const MAX_OPTIONS: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 1024;

/// An input's name: letters, digits, `_` and `-`, starting with a letter or
/// `_`, up to 64.
pub fn is_input_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// Checks one value against its input and answers it as the run reads it:
/// `true` or `false` for a boolean, the number as written (trimmed), the
/// text as given otherwise.
pub fn check_value(spec: &InputSpec, value: &str) -> Result<String, String> {
    check_value_of(spec.kind, &spec.options, value)
}

fn check_value_of(kind: InputKind, options: &[String], value: &str) -> Result<String, String> {
    if value.len() > MAX_INPUT_BYTES {
        return Err(format!("is over {} KiB", MAX_INPUT_BYTES >> 10));
    }
    if value.contains('\0') {
        return Err("contains a NUL byte".into());
    }
    match kind {
        InputKind::String => Ok(value.to_string()),
        InputKind::Boolean => match value {
            "true" | "false" => Ok(value.to_string()),
            _ => Err(format!(
                "is a boolean: `true` or `false`, not `{}`",
                short(value)
            )),
        },
        InputKind::Number => {
            let trimmed = value.trim();
            match trimmed.parse::<f64>() {
                Ok(n) if n.is_finite() && !trimmed.is_empty() && !has_letters(trimmed) => {
                    Ok(trimmed.to_string())
                }
                _ => Err(format!("is a number, not `{}`", short(value))),
            }
        }
        InputKind::Choice => {
            if options.iter().any(|o| o == value) {
                Ok(value.to_string())
            } else {
                Err(format!(
                    "is one of {}, not `{}`",
                    options
                        .iter()
                        .map(|o| format!("`{o}`"))
                        .collect::<Vec<_>>()
                        .join(", "),
                    short(value)
                ))
            }
        }
    }
}

/// `inf`, `NaN` and the like parse as floats; an exponent's `e` is the only
/// letter a number here may have.
fn has_letters(text: &str) -> bool {
    text.bytes()
        .any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E')
}

fn short(value: &str) -> String {
    let mut out: String = value.chars().take(40).collect();
    if out.len() < value.len() {
        out.push('…');
    }
    out.replace('\n', "\\n")
}

/// Checks `on.manual`'s declarations.
pub(crate) fn declare(raw: &raw::Manual, errors: &mut Vec<SpecError>) -> ManualTrigger {
    let mut error = |path: String, message: String| errors.push(SpecError { path, message });
    if raw.inputs.len() > MAX_INPUTS {
        error(
            "on.manual.inputs".into(),
            format!(
                "declares {} inputs; the limit is {MAX_INPUTS}",
                raw.inputs.len()
            ),
        );
    }
    let mut inputs = Vec::new();
    for (name, input) in &raw.inputs {
        let path = format!("on.manual.inputs.{name}");
        if !is_input_name(name) {
            error(
                path.clone(),
                "an input's name uses letters, digits, `_` and `-`, starting with a letter or `_`, up to 64".into(),
            );
        }
        let kind = match input.kind.as_deref() {
            None | Some("string") => InputKind::String,
            Some("boolean") => InputKind::Boolean,
            Some("choice") => InputKind::Choice,
            Some("number") => InputKind::Number,
            Some(other) => {
                error(
                    format!("{path}.type"),
                    format!("is `string`, `boolean`, `choice` or `number`, not `{other}`"),
                );
                InputKind::String
            }
        };
        if let Some(d) = &input.description
            && d.chars().count() > MAX_DESCRIPTION_CHARS
        {
            error(
                format!("{path}.description"),
                format!("is over {MAX_DESCRIPTION_CHARS} characters"),
            );
        }
        match kind {
            InputKind::Choice if input.options.is_empty() => {
                error(
                    format!("{path}.options"),
                    "a `choice` input needs at least one option".into(),
                );
            }
            InputKind::Choice => {
                if input.options.len() > MAX_OPTIONS {
                    error(
                        format!("{path}.options"),
                        format!("lists more than {MAX_OPTIONS} options"),
                    );
                }
                let mut seen = std::collections::HashSet::new();
                for option in &input.options {
                    if option.is_empty()
                        || option.len() > MAX_INPUT_BYTES
                        || option.chars().any(char::is_control)
                    {
                        error(
                            format!("{path}.options"),
                            format!(
                                "`{}` is not an option: one line of text, not empty",
                                short(option)
                            ),
                        );
                    } else if !seen.insert(option) {
                        error(format!("{path}.options"), format!("lists `{option}` twice"));
                    }
                }
            }
            _ if !input.options.is_empty() => {
                error(
                    format!("{path}.options"),
                    "only a `choice` input has options".into(),
                );
            }
            _ => {}
        }
        let default = input.default.as_ref().and_then(|value| {
            let text = match value {
                serde_yaml_ng::Value::String(s) => s.clone(),
                serde_yaml_ng::Value::Bool(b) => b.to_string(),
                serde_yaml_ng::Value::Number(n) => n.to_string(),
                _ => {
                    error(
                        format!("{path}.default"),
                        "is a string, a boolean or a number".into(),
                    );
                    return None;
                }
            };
            match check_value_of(kind, &input.options, &text) {
                Ok(text) => Some(text),
                Err(e) => {
                    error(format!("{path}.default"), e);
                    None
                }
            }
        });
        inputs.push(InputSpec {
            name: name.clone(),
            kind,
            description: input.description.clone(),
            required: input.required,
            default,
            options: if kind == InputKind::Choice {
                input.options.clone()
            } else {
                Vec::new()
            },
        });
    }
    ManualTrigger { inputs }
}

/// The value of every declared input in a run, by name. A manual run's
/// values are checked against their inputs: a name the pipeline does not
/// declare, a value of the wrong type and a required input left out are
/// each an error under `inputs.<name>`. An input not given reads as its
/// default, else `false` for a boolean and empty for the others. Any other
/// event gives no values, so each input reads as that.
pub(crate) fn resolve(
    manual: Option<&ManualTrigger>,
    given: &BTreeMap<String, String>,
    event: Event,
    errors: &mut Vec<SpecError>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(manual) = manual else {
        return out;
    };
    let manual_run = event == Event::Manual;
    if manual_run {
        for name in given.keys() {
            if !manual.inputs.iter().any(|i| &i.name == name) {
                errors.push(SpecError {
                    path: format!("inputs.{name}"),
                    message: format!(
                        "the pipeline declares no input `{name}`; its inputs are under `on.manual.inputs`"
                    ),
                });
            }
        }
    }
    for input in &manual.inputs {
        let value = given
            .get(&input.name)
            .filter(|v| manual_run && !(v.is_empty() && input.kind != InputKind::String))
            .filter(|v| !(v.is_empty() && input.required));
        let resolved = match value {
            Some(v) => match check_value(input, v) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(SpecError {
                        path: format!("inputs.{}", input.name),
                        message: e,
                    });
                    String::new()
                }
            },
            None => match &input.default {
                Some(d) => d.clone(),
                None => {
                    if manual_run && input.required {
                        errors.push(SpecError {
                            path: format!("inputs.{}", input.name),
                            message: "is required".into(),
                        });
                    }
                    match input.kind {
                        InputKind::Boolean => "false".to_string(),
                        _ => String::new(),
                    }
                }
            },
        };
        out.insert(input.name.clone(), resolved);
    }
    out
}

//! Cron expressions for `on.schedule`, always in UTC.
//!
//! Five fields, `minute hour day-of-month month day-of-week`, each `*`, a
//! number, a range `a-b`, a step `*/n` or `a-b/n`, or a comma list of those.
//! Months and weekdays also take names (`jan`, `mon`), Sunday is 0 or 7, and
//! `@hourly`, `@daily` (`@midnight`), `@weekly`, `@monthly` and `@yearly`
//! (`@annually`) stand for their usual expansions. As in classic cron, when
//! both the day of the month and the day of the week are restricted, a day
//! that matches either one runs.

use std::fmt;

/// A parsed expression: which values of each field match.
#[derive(Clone, PartialEq, Eq)]
pub struct Cron {
    source: String,
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    weekdays: u64,
    /// Whether day-of-month and day-of-week were each written as `*`,
    /// which decides how the two combine.
    any_day: bool,
    any_weekday: bool,
}

impl fmt::Debug for Cron {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Cron({:?})", self.source)
    }
}

impl serde::Serialize for Cron {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.source)
    }
}

/// A minute in UTC, broken into the fields cron matches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Minute {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// 0 is Sunday.
    pub weekday: u32,
}

impl Minute {
    /// The minute a Unix time falls in.
    pub fn from_unix(secs: u64) -> Self {
        let days = (secs / 86_400) as i64;
        let rem = secs % 86_400;
        // Civil date from days (Howard Hinnant's algorithm).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = yoe + era * 400 + i64::from(month <= 2);
        Minute {
            year,
            month,
            day,
            hour: (rem / 3600) as u32,
            minute: (rem % 3600 / 60) as u32,
            // 1970-01-01 was a Thursday.
            weekday: (days + 4).rem_euclid(7) as u32,
        }
    }
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn value(text: &str, min: u32, max: u32, names: &[&str], name_base: u32) -> Result<u32, String> {
    let lower = text.to_ascii_lowercase();
    if let Some(i) = names.iter().position(|n| *n == lower) {
        return Ok(i as u32 + name_base);
    }
    let n: u32 = text
        .parse()
        .map_err(|_| format!("`{text}` is not a number"))?;
    if !(min..=max).contains(&n) {
        return Err(format!("{n} is outside {min}-{max}"));
    }
    Ok(n)
}

/// One field as a bit set of the values it matches.
fn field(text: &str, min: u32, max: u32, names: &[&str], name_base: u32) -> Result<u64, String> {
    let mut bits = 0u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s.parse().map_err(|_| format!("`{s}` is not a step"))?;
                if step == 0 {
                    return Err("a step of 0 never advances".into());
                }
                (r, step)
            }
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (
                value(a, min, max, names, name_base)?,
                value(b, min, max, names, name_base)?,
            )
        } else {
            let v = value(range, min, max, names, name_base)?;
            // `5/15` means from 5 to the end, every 15.
            (v, if step > 1 { max } else { v })
        };
        if lo > hi {
            return Err(format!("the range {lo}-{hi} runs backwards"));
        }
        let mut v = lo;
        while v <= hi {
            bits |= 1 << v;
            v += step;
        }
    }
    Ok(bits)
}

impl Cron {
    pub fn parse(text: &str) -> Result<Cron, String> {
        let expanded = match text.trim() {
            "@yearly" | "@annually" => "0 0 1 1 *",
            "@monthly" => "0 0 1 * *",
            "@weekly" => "0 0 * * 0",
            "@daily" | "@midnight" => "0 0 * * *",
            "@hourly" => "0 * * * *",
            other if other.starts_with('@') => return Err(format!("unknown shortcut `{other}`")),
            other => other,
        };
        let fields: Vec<&str> = expanded.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = fields.as_slice() else {
            return Err(format!(
                "`{text}` has {} fields; cron takes 5: minute hour day-of-month month day-of-week",
                fields.len()
            ));
        };
        let named = |what: &str, r: Result<u64, String>| r.map_err(|e| format!("{what}: {e}"));
        let mut weekdays = named("day of week", field(weekday, 0, 7, &WEEKDAYS, 0))?;
        // Sunday is both 0 and 7.
        if weekdays & (1 << 7) != 0 {
            weekdays |= 1;
        }
        Ok(Cron {
            source: text.trim().to_string(),
            minutes: named("minute", field(minute, 0, 59, &[], 0))?,
            hours: named("hour", field(hour, 0, 23, &[], 0))?,
            days: named("day of month", field(day, 1, 31, &[], 0))?,
            months: named("month", field(month, 1, 12, &MONTHS, 1))?,
            weekdays,
            any_day: *day == "*",
            any_weekday: *weekday == "*",
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn matches(&self, t: Minute) -> bool {
        let has = |bits: u64, v: u32| bits & (1 << v) != 0;
        if !has(self.minutes, t.minute) || !has(self.hours, t.hour) || !has(self.months, t.month) {
            return false;
        }
        let day = has(self.days, t.day);
        let weekday = has(self.weekdays, t.weekday);
        match (self.any_day, self.any_weekday) {
            (true, true) => true,
            (false, true) => day,
            (true, false) => weekday,
            (false, false) => day || weekday,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Minute {
        // "2026-11-08 03:00" style, built from its fields directly.
        let (date, time) = s.split_once(' ').unwrap();
        let d: Vec<u32> = date.split('-').map(|p| p.parse().unwrap()).collect();
        let t: Vec<u32> = time.split(':').map(|p| p.parse().unwrap()).collect();
        // Days since the epoch, to get the weekday through from_unix.
        let (y, m) = if d[1] <= 2 {
            (d[0] as i64 - 1, d[1] + 9)
        } else {
            (d[0] as i64, d[1] - 3)
        };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * m as i64 + 2) / 5 + d[2] as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        Minute::from_unix(days as u64 * 86_400 + u64::from(t[0]) * 3600 + u64::from(t[1]) * 60)
    }

    #[test]
    fn unix_times_break_into_fields() {
        assert_eq!(
            Minute::from_unix(0),
            Minute {
                year: 1970,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0,
                weekday: 4
            }
        );
        let m = Minute::from_unix(1_793_491_200 + 3 * 3600 + 7 * 60); // 2026-11-01 03:07, a Sunday
        assert_eq!(
            (m.year, m.month, m.day, m.hour, m.minute, m.weekday),
            (2026, 11, 1, 3, 7, 0)
        );
        assert_eq!(at("2024-02-29 12:30").weekday, 4);
    }

    #[test]
    fn fields_steps_ranges_names_and_shortcuts() {
        let c = Cron::parse("0 3 * * *").unwrap();
        assert!(c.matches(at("2026-11-08 03:00")));
        assert!(!c.matches(at("2026-11-08 03:01")));
        let c = Cron::parse("*/15 9-17 * * mon-fri").unwrap();
        assert!(c.matches(at("2026-11-09 09:45")), "a Monday");
        assert!(!c.matches(at("2026-11-08 09:45")), "a Sunday");
        assert!(!c.matches(at("2026-11-09 18:00")));
        let c = Cron::parse("5/20 * * * *").unwrap();
        assert!(c.matches(at("2026-11-09 10:45")) && !c.matches(at("2026-11-09 10:50")));
        let c = Cron::parse("0 0 1,15 jan,JUL *").unwrap();
        assert!(c.matches(at("2026-07-15 00:00")) && !c.matches(at("2026-08-15 00:00")));
        assert!(
            Cron::parse("0 0 * * 7")
                .unwrap()
                .matches(at("2026-11-08 00:00")),
            "7 is Sunday"
        );
        assert!(
            Cron::parse("@daily")
                .unwrap()
                .matches(at("2026-11-08 00:00"))
        );
        assert!(
            Cron::parse("@weekly")
                .unwrap()
                .matches(at("2026-11-08 00:00"))
        );
        assert!(
            !Cron::parse("@monthly")
                .unwrap()
                .matches(at("2026-11-08 00:00"))
        );
    }

    #[test]
    fn day_of_month_and_day_of_week_either_match_when_both_are_set() {
        let c = Cron::parse("0 0 13 * fri").unwrap();
        assert!(c.matches(at("2026-11-13 00:00")), "the 13th, a Friday");
        assert!(c.matches(at("2026-11-06 00:00")), "a Friday");
        assert!(c.matches(at("2026-12-13 00:00")), "the 13th, a Sunday");
        assert!(!c.matches(at("2026-11-07 00:00")));
    }

    #[test]
    fn mistakes_are_named() {
        for (text, needle) in [
            ("0 3 * *", "has 4 fields"),
            ("60 * * * *", "minute: 60 is outside 0-59"),
            ("* 24 * * *", "hour"),
            ("* * 0 * *", "day of month"),
            ("* * * 13 *", "month"),
            ("* * * * 8", "day of week"),
            ("*/0 * * * *", "step of 0"),
            ("5-1 * * * *", "backwards"),
            ("x * * * *", "not a number"),
            ("@often", "unknown shortcut"),
        ] {
            let err = Cron::parse(text).unwrap_err();
            assert!(err.contains(needle), "{text}: {err}");
        }
    }
}

//! `90s`, `10m`, `1h30m`, `7d` and `512MiB`, `4GiB`.

pub(crate) fn parse_duration_secs(text: &str) -> Option<u64> {
    let mut total: u64 = 0;
    let mut digits = String::new();
    let mut any = false;
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86_400,
            _ => return None,
        };
        let n: u64 = digits.parse().ok()?;
        total = total.checked_add(n.checked_mul(unit)?)?;
        digits.clear();
        any = true;
    }
    // A bare number, or a trailing number with no unit, is ambiguous.
    (any && digits.is_empty()).then_some(total)
}

pub(crate) fn parse_bytes(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text.find(|c: char| !c.is_ascii_digit())?;
    let (n, unit) = text.split_at(split);
    let n: u64 = n.parse().ok()?;
    let mult: u64 = match unit.trim() {
        "KiB" | "K" => 1 << 10,
        "MiB" | "M" => 1 << 20,
        "GiB" | "G" => 1 << 30,
        _ => return None,
    };
    n.checked_mul(mult)
}

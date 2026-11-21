//! A column type for each column of a file, from what its first rows hold (ANG-46).

/// The most specific type every value fits; `text` when none does. Empty values count for
/// nothing (they are `NULL`), and a column with nothing in it is `text`.
pub fn suggest_type<'a>(values: impl Iterator<Item = &'a str>) -> &'static str {
    // Each candidate stays true while every value so far fits it.
    let (mut integer, mut small, mut decimal, mut boolean, mut uuid) =
        (true, true, true, true, true);
    let (mut date, mut timestamp, mut timestamptz, mut json) = (true, true, true, true);
    let mut any = false;
    for value in values {
        let v = value.trim();
        if v.is_empty() {
            continue;
        }
        any = true;
        let int = is_integer(v);
        integer &= int && v.parse::<i64>().is_ok();
        small &= int && v.parse::<i32>().is_ok();
        decimal &= is_decimal(v);
        boolean &= matches!(
            v.to_ascii_lowercase().as_str(),
            "true" | "false" | "t" | "f"
        );
        uuid &= is_uuid(v);
        date &= is_date(v);
        let stamp = parse_timestamp(v);
        timestamp &= stamp == Some(false);
        timestamptz &= stamp == Some(true);
        json &= (v.starts_with('{') || v.starts_with('['))
            && serde_json::from_str::<serde_json::Value>(v).is_ok();
        if !(integer || decimal || boolean || uuid || date || timestamp || timestamptz || json) {
            break;
        }
    }
    if !any {
        return "text";
    }
    if small {
        "integer"
    } else if integer {
        "bigint"
    } else if decimal {
        "numeric"
    } else if boolean {
        "boolean"
    } else if uuid {
        "uuid"
    } else if date {
        "date"
    } else if timestamptz {
        "timestamptz"
    } else if timestamp {
        "timestamp"
    } else if json {
        "jsonb"
    } else {
        "text"
    }
}

fn is_integer(v: &str) -> bool {
    let digits = v.strip_prefix(['-', '+']).unwrap_or(v);
    // A leading zero is an identifier ("007"), not a number: keep it as text.
    !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits.len() == 1 || !digits.starts_with('0'))
}

fn is_decimal(v: &str) -> bool {
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (body, None),
    };
    if let Some(e) = exponent {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        if e.is_empty() || !e.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (mantissa, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|f| !digits(f)) {
        return false;
    }
    if whole.is_empty() && fraction.is_none_or(str::is_empty) {
        return false;
    }
    // A leading zero before more digits is an identifier.
    whole.len() <= 1 || !whole.starts_with('0') || fraction.is_some()
}

fn is_uuid(v: &str) -> bool {
    let parts: Vec<&str> = v.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_date(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
        && matches!(v[5..7].parse::<u32>(), Ok(1..=12))
        && matches!(v[8..10].parse::<u32>(), Ok(1..=31))
}

/// `Some(has_zone)` for `2026-01-02 03:04:05[.123][Z|+01[:00]]` (a `T` works too).
fn parse_timestamp(v: &str) -> Option<bool> {
    if v.len() < 19 || !is_date(&v[..10]) || !matches!(v.as_bytes()[10], b' ' | b'T') {
        return None;
    }
    let rest = &v[11..];
    let (time, zone) = match rest.find(['Z', '+', '-']) {
        Some(i) => (&rest[..i], Some(&rest[i..])),
        None => (rest, None),
    };
    let (clock, fraction) = match time.split_once('.') {
        Some((c, f)) => (c, Some(f)),
        None => (time, None),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    let ok = parts.len() == 3
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit()))
        && matches!(parts[0].parse::<u32>(), Ok(0..=24))
        && matches!(parts[1].parse::<u32>(), Ok(0..=59))
        && matches!(parts[2].parse::<u32>(), Ok(0..=60))
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
    if !ok {
        return None;
    }
    match zone {
        None => Some(false),
        Some("Z") => Some(true),
        Some(z) => {
            let offset = &z[1..];
            let valid = !offset.is_empty()
                && offset
                    .split(':')
                    .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit()))
                && offset.split(':').count() <= 2;
            valid.then_some(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(values: &[&str]) -> &'static str {
        suggest_type(values.iter().copied())
    }

    #[test]
    fn numbers_get_the_smallest_type_that_holds_them() {
        assert_eq!(kind(&["1", "-2", "300"]), "integer");
        assert_eq!(kind(&["1", "3000000000"]), "bigint");
        assert_eq!(kind(&["1", "2.5"]), "numeric");
        assert_eq!(kind(&["1e5", "2.5E-3", ".5"]), "numeric");
        assert_eq!(kind(&["99999999999999999999"]), "numeric");
        // An identifier with a leading zero is text, and so is anything mixed.
        assert_eq!(kind(&["007", "010"]), "text");
        assert_eq!(kind(&["1", "x"]), "text");
        // PostgreSQL reads "1." as a number.
        assert_eq!(kind(&["1.", "2"]), "numeric");
        assert_eq!(kind(&["-", "+"]), "text");
    }

    #[test]
    fn other_types_are_recognised() {
        assert_eq!(kind(&["true", "False", "t"]), "boolean");
        assert_eq!(kind(&["1", "0"]), "integer"); // 1/0 are numbers
        assert_eq!(kind(&["123e4567-e89b-12d3-a456-426614174000"]), "uuid");
        assert_eq!(kind(&["2026-01-02", "1999-12-31"]), "date");
        assert_eq!(kind(&["2026-13-02"]), "text");
        assert_eq!(
            kind(&["2026-01-02 03:04:05", "2026-01-02T03:04:05.123"]),
            "timestamp"
        );
        assert_eq!(
            kind(&[
                "2026-01-02 03:04:05+00",
                "2026-01-02T03:04:05Z",
                "2026-01-02 03:04:05-05:30"
            ]),
            "timestamptz"
        );
        // Some with a zone and some without is not one type.
        assert_eq!(
            kind(&["2026-01-02 03:04:05", "2026-01-02 03:04:05Z"]),
            "text"
        );
        assert_eq!(kind(&["{\"a\": 1}", "[1, 2]"]), "jsonb");
        assert_eq!(kind(&["{not json"]), "text");
    }

    #[test]
    fn empty_values_count_for_nothing() {
        assert_eq!(kind(&["1", "", "  ", "2"]), "integer");
        assert_eq!(kind(&["", ""]), "text");
        assert_eq!(kind(&[]), "text");
    }
}

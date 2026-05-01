use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Serialize, Serializer};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Timestamp {
    millis: u64,
}

impl Timestamp {
    pub(crate) fn now() -> Self {
        Self::try_from(SystemTime::now()).expect("system clock is before unix epoch")
    }

    pub(crate) fn from_rpc(input: impl RpcTimestampInput) -> Option<Self> {
        input.parse_timestamp()
    }

    pub(crate) fn millis(self) -> u64 {
        self.millis
    }

    fn from_epoch_millis(millis: u64) -> Self {
        Self { millis }
    }
}

pub(crate) trait RpcTimestampInput {
    fn parse_timestamp(self) -> Option<Timestamp>;
}

impl RpcTimestampInput for &Value {
    fn parse_timestamp(self) -> Option<Timestamp> {
        if let Some(millis) = self.as_u64() {
            return Some(Timestamp::from_epoch_millis(millis));
        }
        self.as_str()
            .and_then(parse_rfc3339_utc_millis)
            .map(Timestamp::from_epoch_millis)
    }
}

impl RpcTimestampInput for &str {
    fn parse_timestamp(self) -> Option<Timestamp> {
        parse_rfc3339_utc_millis(self).map(Timestamp::from_epoch_millis)
    }
}

impl TryFrom<SystemTime> for Timestamp {
    type Error = std::time::SystemTimeError;

    fn try_from(value: SystemTime) -> Result<Self, Self::Error> {
        let duration = value.duration_since(UNIX_EPOCH)?;
        Ok(Self::from_epoch_millis(
            u64::try_from(duration.as_millis()).expect("timestamp milliseconds exceed u64"),
        ))
    }
}

impl Serialize for Timestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u64(self.millis)
    }
}

fn parse_rfc3339_utc_millis(value: &str) -> Option<u64> {
    let (date, rest) = value.split_once('T')?;
    let (time, offset) = split_time_offset(rest)?;
    let offset_seconds = parse_offset_seconds(offset)?;

    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }

    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_and_fraction = time_parts.next()?;
    if time_parts.next().is_some() {
        return None;
    }

    let (second_str, fraction_str) = second_and_fraction
        .split_once('.')
        .map_or((second_and_fraction, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let second = second_str.parse::<u32>().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let fraction_millis = parse_fraction_millis(fraction_str.unwrap_or(""))?;
    let day_seconds = u64::from(hour) * 3_600 + u64::from(minute) * 60 + u64::from(second.min(59));
    let epoch_seconds = days_from_civil(year, month, day)?.checked_mul(86_400)?;
    let utc_seconds =
        i128::from(epoch_seconds) + i128::from(day_seconds) - i128::from(offset_seconds);
    if utc_seconds < 0 {
        return None;
    }
    u64::try_from(utc_seconds)
        .ok()?
        .checked_mul(1_000)?
        .checked_add(fraction_millis)
}

fn split_time_offset(rest: &str) -> Option<(&str, &str)> {
    if let Some(time) = rest.strip_suffix('Z') {
        return Some((time, "Z"));
    }
    let offset_start = rest
        .char_indices()
        .skip(1)
        .find_map(|(index, ch)| matches!(ch, '+' | '-').then_some(index))?;
    Some((&rest[..offset_start], &rest[offset_start..]))
}

fn parse_offset_seconds(offset: &str) -> Option<i32> {
    if offset == "Z" {
        return Some(0);
    }
    let sign = match offset.as_bytes().first().copied()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let mut parts = offset[1..].split(':');
    let hours = parts.next()?.parse::<i32>().ok()?;
    let minutes = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() || hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 3_600 + minutes * 60))
}

fn parse_fraction_millis(fraction: &str) -> Option<u64> {
    if fraction.is_empty() {
        return Some(0);
    }
    if !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let mut millis = 0_u64;
    for (index, byte) in fraction.bytes().take(3).enumerate() {
        let digit = u64::from(byte - b'0');
        millis += digit * 10_u64.pow(u32::try_from(2 - index).ok()?);
    }
    Some(millis)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<u64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rpc_millis_number() {
        let value = serde_json::json!(1_770_000_000_123_u64);
        let timestamp = Timestamp::from_rpc(&value).expect("timestamp parses");
        assert_eq!(timestamp.millis(), 1_770_000_000_123);
    }

    #[test]
    fn parses_rpc_utc_string_with_fraction() {
        let timestamp = Timestamp::from_rpc("2026-04-30T12:34:56.789Z").expect("timestamp parses");
        assert_eq!(timestamp.millis(), 1_777_552_496_789);
    }

    #[test]
    fn parses_rpc_string_with_offset() {
        let timestamp =
            Timestamp::from_rpc("2026-04-30T14:34:56.001+02:00").expect("timestamp parses");
        assert_eq!(timestamp.millis(), 1_777_552_496_001);
    }
}

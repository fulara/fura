use std::{
    collections::HashMap,
    fmt,
    fs::Metadata,
    io::{self, BufRead, Read},
    time::SystemTime,
};

use serde::{
    Deserialize, Deserializer,
    de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;

use crate::Timestamp;

/// Filesystem identity is only an invalidation key, never conversation activity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionFileStamp {
    modified: Option<SystemTime>,
    length: u64,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl SessionFileStamp {
    pub(crate) fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            modified: metadata.modified().ok(),
            length: metadata.len(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed_seconds: metadata.ctime(),
            #[cfg(unix)]
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
}

fn conversational_role(
    role: Option<&str>,
    agent_attributed: bool,
    assistant_content: bool,
) -> bool {
    match role {
        Some("user") => !agent_attributed,
        Some("assistant") => assistant_content,
        _ => false,
    }
}

fn conversational_block(kind: &str) -> bool {
    matches!(
        kind,
        "text" | "thinking" | "image" | "redactedThinking" | "redacted_thinking"
    )
}

/// Raw OMP messages only: projected custom/system/tool messages cannot become activity.
pub(crate) fn conversation_message_timestamp(
    message: &Value,
    enclosing: Option<Timestamp>,
) -> Option<Timestamp> {
    let assistant_content = match message.get("content") {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(blocks)) => blocks.iter().any(|block| {
            block
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(conversational_block)
        }),
        _ => false,
    } || message
        .get("errorMessage")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty());
    conversational_role(
        message.get("role").and_then(Value::as_str),
        message.get("attribution").and_then(Value::as_str) == Some("agent"),
        assistant_content,
    )
    .then(|| {
        message
            .get("timestamp")
            .and_then(Timestamp::from_rpc)
            .or(enclosing)
    })
    .flatten()
}

/// A JSONL record reader that cannot consume the next record on malformed JSON.
/// Draining after parsing lets callers recover at the next physical line without allocating it.
struct JsonLine<'a, R> {
    reader: &'a mut R,
    ended: bool,
    consumed: u64,
}

impl<R: BufRead> Read for JsonLine<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.ended || output.is_empty() {
            return Ok(0);
        }
        let available = self.reader.fill_buf()?;
        let length = available[..available.len().min(output.len())]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len().min(output.len()), |index| index + 1);
        if length == 0 {
            self.ended = true;
            return Ok(0);
        }
        self.ended = available[length - 1] == b'\n';
        output[..length].copy_from_slice(&available[..length]);
        self.reader.consume(length);
        self.consumed += length as u64;
        Ok(length)
    }
}

pub(crate) fn read_json_line<T: for<'de> Deserialize<'de>>(
    reader: &mut impl BufRead,
) -> io::Result<Option<(u64, Result<T, serde_json::Error>)>> {
    if reader.fill_buf()?.is_empty() {
        return Ok(None);
    }
    let mut line = JsonLine {
        reader,
        ended: false,
        consumed: 0,
    };
    let result = {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut line);
        T::deserialize(&mut deserializer).and_then(|value| deserializer.end().map(|()| value))
    };
    io::copy(&mut line, &mut io::sink())?;
    Ok(Some((line.consumed, result)))
}

#[derive(Default)]
struct ContentSummary(bool);

impl<'de> Deserialize<'de> for ContentSummary {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ContentVisitor;
        impl<'de> Visitor<'de> for ContentVisitor {
            type Value = ContentSummary;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("message content")
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(ContentSummary(!value.is_empty()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(ContentSummary(false))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                #[derive(Deserialize)]
                struct Block {
                    #[serde(rename = "type", default)]
                    kind: String,
                }
                let mut conversational = false;
                while let Some(block) = sequence.next_element::<Block>()? {
                    conversational |= conversational_block(&block.kind);
                }
                Ok(ContentSummary(conversational))
            }
        }
        deserializer.deserialize_any(ContentVisitor)
    }
}

#[derive(Default)]
struct MessageFact {
    role: Option<String>,
    attribution: Option<String>,
    timestamp: Option<Value>,
    content: ContentSummary,
    error_message: Option<String>,
}

impl<'de> Deserialize<'de> for MessageFact {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MessageVisitor;
        impl<'de> Visitor<'de> for MessageVisitor {
            type Value = MessageFact;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("raw message")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut message = MessageFact::default();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "role" => message.role = map.next_value()?,
                        "attribution" => message.attribution = map.next_value()?,
                        "timestamp" => message.timestamp = map.next_value()?,
                        "errorMessage" => message.error_message = map.next_value()?,
                        "content"
                            if message
                                .role
                                .as_deref()
                                .is_some_and(|role| role != "assistant") =>
                        {
                            let _: IgnoredAny = map.next_value()?;
                        }
                        "content" => message.content = map.next_value()?,
                        _ => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(message)
            }
        }
        deserializer.deserialize_map(MessageVisitor)
    }
}

fn explicit_parent<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct JournalFact {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) id: Option<String>,
    #[serde(deserialize_with = "explicit_parent")]
    parent_id: Option<Option<String>>,
    pub(crate) timestamp: Option<Value>,
    pub(crate) cwd: Option<String>,
    pub(crate) title: Option<String>,
    message: Option<MessageFact>,
}

impl JournalFact {
    pub(crate) fn is_user_message(&self) -> bool {
        self.kind == "message"
            && self
                .message
                .as_ref()
                .is_some_and(|message| message.role.as_deref() == Some("user"))
    }

    fn activity(&self) -> Option<Timestamp> {
        if self.kind != "message" {
            return None;
        }
        let message = self.message.as_ref()?;
        conversational_role(
            message.role.as_deref(),
            message.attribution.as_deref() == Some("agent"),
            message.content.0
                || message
                    .error_message
                    .as_deref()
                    .is_some_and(|error| !error.is_empty()),
        )
        .then(|| {
            message
                .timestamp
                .as_ref()
                .and_then(Timestamp::from_rpc)
                .or_else(|| self.timestamp.as_ref().and_then(Timestamp::from_rpc))
        })
        .flatten()
    }
}

/// Transient branch metadata only. Archived records are ancestors too; compaction
/// is not a reason to discard their activity. An explicit unknown parent stops.
#[derive(Default)]
pub(crate) struct JournalRecency {
    last_message_at: Option<Timestamp>,
    ids: HashMap<String, Option<Timestamp>>,
}

impl JournalRecency {
    pub(crate) fn push(&mut self, fact: JournalFact) {
        // Header/title-slot lines are not journal leaves.
        if fact.kind.is_empty() || matches!(fact.kind.as_str(), "session" | "title") {
            return;
        }
        let parent = match &fact.parent_id {
            Some(Some(id)) => self.ids.get(id).copied().flatten(),
            Some(None) => None,
            None => self.last_message_at,
        };
        self.last_message_at = parent.max(fact.activity());
        if let Some(id) = fact.id {
            self.ids.insert(id, self.last_message_at);
        }
    }

    pub(crate) fn last_message_at(&self) -> Option<Timestamp> {
        self.last_message_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufReader, Cursor};

    fn timestamp(millis: u64) -> Timestamp {
        Timestamp::from_rpc(&json!(millis)).unwrap()
    }

    fn scan(entries: &[Value]) -> Option<Timestamp> {
        let mut recency = JournalRecency::default();
        for entry in entries {
            recency.push(serde_json::from_value(entry.clone()).unwrap());
        }
        recency.last_message_at()
    }

    #[test]
    fn raw_conversation_predicate_matches_disk_and_rejects_bookkeeping() {
        let messages = [
            (json!({"role":"user","content":"prompt"}), true),
            (
                json!({"role":"user","attribution":"agent","content":"injected"}),
                false,
            ),
            (
                json!({"role":"assistant","content":[{"type":"toolCall","id":"t","name":"read"}]}),
                false,
            ),
            (
                json!({"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"toolCall"}]}),
                true,
            ),
            (
                json!({"role":"assistant","content":[{"type":"thinking","thinking":"reason"}]}),
                true,
            ),
            (
                json!({"role":"assistant","content":[{"type":"image","data":"image"}]}),
                true,
            ),
            (
                json!({"role":"assistant","content":[{"type":"redactedThinking","data":"secret"}]}),
                true,
            ),
            (
                json!({"role":"assistant","content":[],"errorMessage":"provider failed"}),
                true,
            ),
            (json!({"role":"assistant","content":[]}), false),
            (json!({"role":"developer","content":"instruction"}), false),
            (
                json!({"role":"toolResult","content":[{"type":"text","text":"result"}]}),
                false,
            ),
            (
                json!({"role":"custom","display":true,"content":"notice"}),
                false,
            ),
            (
                json!({"role":"compactionSummary","content":"summary"}),
                false,
            ),
            (json!({"role":"branchSummary","content":"summary"}), false),
        ];
        for (message, eligible) in messages {
            let expected = eligible.then(|| timestamp(20));
            assert_eq!(
                conversation_message_timestamp(&message, Some(timestamp(20))),
                expected,
                "{message}"
            );
            assert_eq!(
                scan(&[json!({"type":"message","timestamp":20,"message":message})]),
                expected
            );
        }
    }

    #[test]
    fn valid_inner_timestamp_wins_and_invalid_inner_uses_enclosing_time() {
        assert_eq!(
            scan(&[json!({
                "type":"message","timestamp":9000,
                "message":{"role":"user","timestamp":100,"content":"first"}
            })]),
            Some(timestamp(100))
        );
        assert_eq!(
            scan(&[json!({
                "type":"message","timestamp":"2026-01-01T00:00:00Z",
                "message":{"role":"assistant","timestamp":"bad","content":[{"type":"text","text":"answer"}]}
            })]),
            Timestamp::from_rpc("2026-01-01T00:00:00Z")
        );
        assert_eq!(
            scan(&[json!({
                "type":"message","timestamp":"bad",
                "message":{"role":"user","timestamp":-1,"content":"legacy"}
            })]),
            None
        );
    }

    #[test]
    fn active_branch_includes_archived_ancestors_but_not_abandoned_descendants() {
        let ancestor = json!({"type":"message","id":"a","parentId":null,"archived":true,
            "message":{"role":"user","timestamp":100,"content":"ancestor"}});
        let abandoned = json!({"type":"message","id":"b","parentId":"a",
            "message":{"role":"assistant","timestamp":900,"content":[{"type":"text","text":"abandoned"}]}});
        let compacted = json!({"type":"compaction","id":"c","parentId":"a","timestamp":1000,
            "firstKeptEntryId":"c","summary":"archived summary"});
        let marker = json!({"type":"branch_summary","id":"d","parentId":"c","timestamp":2000,"summary":"rewound"});
        assert_eq!(
            scan(&[ancestor.clone(), abandoned, compacted.clone(), marker]),
            Some(timestamp(100))
        );
        // A fork has its own newer header, but keeps the same inherited message time.
        assert_eq!(
            scan(&[
                json!({"type":"session","id":"fork","timestamp":3000}),
                ancestor,
                compacted
            ]),
            Some(timestamp(100))
        );
    }

    #[test]
    fn absent_legacy_links_are_linear_but_explicit_unknown_or_null_links_stop() {
        let message = json!({"type":"message","id":"a","message":{"role":"user","timestamp":100,"content":"old"}});
        let legacy = json!({"type":"mode_change","timestamp":900,"mode":"none"});
        assert_eq!(
            scan(&[message.clone(), legacy.clone()]),
            Some(timestamp(100))
        );
        assert_eq!(
            scan(&[
                message.clone(),
                json!({"type":"branch_summary","parentId":"missing","timestamp":900})
            ]),
            None
        );
        assert_eq!(
            scan(&[
                message,
                json!({"type":"branch_summary","parentId":null,"timestamp":900}),
                legacy
            ]),
            None
        );
    }

    #[test]
    fn ancestry_uses_max_authoritative_time_not_physical_arrival_order() {
        assert_eq!(
            scan(&[
                json!({"type":"message","id":"a","message":{"role":"user","timestamp":100,"content":"first"}}),
                json!({"type":"message","id":"b","parentId":"a","message":{"role":"assistant","timestamp":90,"content":"second"}}),
                json!({"type":"reset_boundary","id":"c","parentId":"b","timestamp":900}),
            ]),
            Some(timestamp(100))
        );
    }

    #[test]
    fn malformed_records_cannot_swallow_the_next_jsonl_record() {
        let bytes = concat!(
            "{\"type\":\"message\",\"message\":\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"timestamp\":100,\"content\":\"kept\"}}\n",
            "{\"type\":\"mode_change\",\"timestamp\":999} trailing garbage\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"timestamp\":200,\"content\":[{\"type\":\"text\",\"text\":\"last\"}]}}"
        );
        let mut reader = BufReader::with_capacity(7, Cursor::new(bytes));
        let mut recency = JournalRecency::default();
        let mut malformed = 0;
        while let Some((_, line)) = read_json_line::<JournalFact>(&mut reader).unwrap() {
            match line {
                Ok(fact) => recency.push(fact),
                Err(_) => malformed += 1,
            }
        }
        assert_eq!(malformed, 2);
        assert_eq!(recency.last_message_at(), Some(timestamp(200)));
    }

    #[test]
    fn long_payloads_are_skipped_without_losing_early_or_late_activity() {
        let payload = "x".repeat(2 * 1024 * 1024);
        let bytes = format!(
            "{{\"type\":\"message\",\"id\":\"a\",\"message\":{{\"role\":\"user\",\"timestamp\":100,\"content\":\"prompt\"}}}}\n\
             {{\"type\":\"message\",\"id\":\"b\",\"parentId\":\"a\",\"message\":{{\"role\":\"toolResult\",\"timestamp\":900,\"content\":\"{payload}\"}}}}\n\
             {{\"type\":\"compaction\",\"id\":\"c\",\"parentId\":\"b\",\"timestamp\":1000,\"summary\":\"{payload}\"}}\n\
             {{\"type\":\"message\",\"id\":\"d\",\"parentId\":\"c\",\"message\":{{\"role\":\"assistant\",\"timestamp\":200,\"content\":[{{\"type\":\"image\",\"data\":\"{payload}\"}}]}}}}\n"
        );
        let mut reader = BufReader::with_capacity(127, Cursor::new(bytes));
        let mut recency = JournalRecency::default();
        while let Some((_, line)) = read_json_line::<JournalFact>(&mut reader).unwrap() {
            recency.push(line.unwrap());
        }
        assert_eq!(recency.last_message_at(), Some(timestamp(200)));
    }
}

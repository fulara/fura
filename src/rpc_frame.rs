use base64::{Engine as _, engine::general_purpose};
use serde_json::Value;

pub(crate) const MAX_RPC_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RPC_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(Debug, Default)]
pub(crate) struct RpcFrameDecoder {
    pending: Option<PendingRpcChunks>,
}

#[derive(Debug)]
struct PendingRpcChunks {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    next_index: usize,
    chunks: Vec<u8>,
}

impl RpcFrameDecoder {
    pub(crate) fn push_line(&mut self, line: &str) -> Result<Option<Value>, RpcFrameDecodeError> {
        if line.len() > MAX_RPC_FRAME_BYTES {
            return Err(RpcFrameDecodeError::new(format!(
                "RPC physical frame exceeds {MAX_RPC_FRAME_BYTES} bytes"
            )));
        }
        let frame: Value = serde_json::from_str(line).map_err(|error| {
            RpcFrameDecodeError::new(format!("invalid RPC JSONL frame: {error}"))
        })?;
        self.push_value(frame)
    }

    pub(crate) fn push_value(
        &mut self,
        frame: Value,
    ) -> Result<Option<Value>, RpcFrameDecodeError> {
        if frame.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
            if self.pending.is_some() {
                self.pending = None;
                return Err(RpcFrameDecodeError::new(
                    "non-chunk RPC frame interrupted a chunked response",
                ));
            }
            return Ok(Some(frame));
        }

        let chunk = RpcChunk::from_value(frame)?;
        if chunk.byte_length > MAX_RPC_REASSEMBLED_BYTES {
            self.pending = None;
            return Err(RpcFrameDecodeError::new(format!(
                "RPC logical frame exceeds {MAX_RPC_REASSEMBLED_BYTES} bytes"
            )));
        }

        if chunk.index == 0 {
            self.pending = Some(PendingRpcChunks {
                chunk_id: chunk.chunk_id.clone(),
                count: chunk.count,
                byte_length: chunk.byte_length,
                next_index: 0,
                chunks: Vec::with_capacity(chunk.byte_length.min(MAX_RPC_FRAME_BYTES)),
            });
        }

        let Some(pending) = self.pending.as_mut() else {
            return Err(RpcFrameDecodeError::new(
                "RPC chunk sequence did not start at index 0",
            ));
        };

        if pending.chunk_id != chunk.chunk_id
            || pending.count != chunk.count
            || pending.byte_length != chunk.byte_length
            || pending.next_index != chunk.index
        {
            self.pending = None;
            return Err(RpcFrameDecodeError::new("inconsistent RPC chunk metadata"));
        }

        let decoded = general_purpose::STANDARD
            .decode(chunk.data.as_bytes())
            .map_err(|error| {
                RpcFrameDecodeError::new(format!("invalid RPC chunk base64: {error}"))
            })?;
        if decoded.len() > RPC_CHUNK_PAYLOAD_BYTES {
            self.pending = None;
            return Err(RpcFrameDecodeError::new(format!(
                "RPC chunk payload exceeds {RPC_CHUNK_PAYLOAD_BYTES} bytes"
            )));
        }
        if pending.chunks.len() + decoded.len() > pending.byte_length {
            self.pending = None;
            return Err(RpcFrameDecodeError::new(
                "RPC chunks exceed declared byte length",
            ));
        }
        pending.chunks.extend_from_slice(&decoded);
        pending.next_index += 1;

        if pending.next_index < pending.count {
            return Ok(None);
        }

        let pending = self.pending.take().expect("pending chunks checked above");
        if pending.chunks.len() != pending.byte_length {
            return Err(RpcFrameDecodeError::new(
                "RPC chunks did not match declared byte length",
            ));
        }
        let frame: Value = serde_json::from_slice(&pending.chunks).map_err(|error| {
            RpcFrameDecodeError::new(format!("reassembled RPC frame is not valid JSON: {error}"))
        })?;
        if !frame.is_object() {
            return Err(RpcFrameDecodeError::new(
                "reassembled RPC frame is not a JSON object",
            ));
        }
        Ok(Some(frame))
    }
}

#[derive(Debug)]
struct RpcChunk {
    chunk_id: String,
    index: usize,
    count: usize,
    byte_length: usize,
    data: String,
}

impl RpcChunk {
    fn from_value(value: Value) -> Result<Self, RpcFrameDecodeError> {
        let object = value
            .as_object()
            .ok_or_else(|| RpcFrameDecodeError::new("RPC chunk is not an object"))?;
        let chunk_id = required_str(object, "chunkId")?.to_string();
        let index = required_usize(object, "index")?;
        let count = required_usize(object, "count")?;
        let byte_length = required_usize(object, "byteLength")?;
        let data = required_str(object, "data")?.to_string();
        if count == 0 {
            return Err(RpcFrameDecodeError::new("RPC chunk count is zero"));
        }
        if index >= count {
            return Err(RpcFrameDecodeError::new("RPC chunk index is out of bounds"));
        }
        Ok(Self {
            chunk_id,
            index,
            count,
            byte_length,
            data,
        })
    }
}

fn required_str<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, RpcFrameDecodeError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcFrameDecodeError::new(format!("RPC chunk missing string field {field}")))
}

fn required_usize(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<usize, RpcFrameDecodeError> {
    let value = object.get(field).and_then(Value::as_u64).ok_or_else(|| {
        RpcFrameDecodeError::new(format!("RPC chunk missing integer field {field}"))
    })?;
    usize::try_from(value)
        .map_err(|_| RpcFrameDecodeError::new(format!("RPC chunk field {field} is too large")))
}

#[derive(Debug, Clone)]
pub(crate) struct RpcFrameDecodeError {
    message: String,
}

impl RpcFrameDecodeError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RpcFrameDecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RpcFrameDecodeError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk_frame(chunk_id: &str, index: usize, count: usize, bytes: &[u8]) -> Value {
        json!({
            "type": "rpc_chunk",
            "chunkId": chunk_id,
            "index": index,
            "count": count,
            "byteLength": bytes.len(),
            "data": general_purpose::STANDARD.encode(bytes),
        })
    }

    fn chunk_part(
        chunk_id: &str,
        index: usize,
        count: usize,
        byte_length: usize,
        bytes: &[u8],
    ) -> Value {
        json!({
            "type": "rpc_chunk",
            "chunkId": chunk_id,
            "index": index,
            "count": count,
            "byteLength": byte_length,
            "data": general_purpose::STANDARD.encode(bytes),
        })
    }

    #[test]
    fn reassembles_chunked_rpc_frame() {
        let bytes =
            br#"{"type":"response","command":"get_state","success":true,"data":{"ok":true}}"#;
        let mut decoder = RpcFrameDecoder::default();
        assert!(
            decoder
                .push_value(chunk_part("a", 0, 2, bytes.len(), &bytes[..20]))
                .unwrap()
                .is_none()
        );
        let frame = decoder
            .push_value(chunk_part("a", 1, 2, bytes.len(), &bytes[20..]))
            .unwrap()
            .expect("complete frame");
        assert_eq!(frame["type"], "response");
        assert_eq!(frame["command"], "get_state");
    }

    #[test]
    fn rejects_non_chunk_interruption() {
        let bytes = br#"{"type":"response"}"#;
        let mut decoder = RpcFrameDecoder::default();
        assert!(
            decoder
                .push_value(chunk_part("a", 0, 2, bytes.len(), &bytes[..8]))
                .unwrap()
                .is_none()
        );
        let error = decoder.push_value(json!({ "type": "ready" })).unwrap_err();
        assert!(error.to_string().contains("interrupted"));
    }

    #[test]
    fn rejects_wrong_chunk_index() {
        let bytes = br#"{"type":"response"}"#;
        let mut decoder = RpcFrameDecoder::default();
        assert!(
            decoder
                .push_value(chunk_part("a", 0, 3, bytes.len(), &bytes[..8]))
                .unwrap()
                .is_none()
        );
        let error = decoder
            .push_value(chunk_part("a", 2, 3, bytes.len(), &bytes[8..]))
            .unwrap_err();
        assert!(error.to_string().contains("metadata"));
    }

    #[test]
    fn rejects_wrong_byte_length() {
        let bytes = br#"{"type":"response"}"#;
        let mut decoder = RpcFrameDecoder::default();
        let error = decoder
            .push_value(chunk_part("a", 0, 1, bytes.len() + 1, bytes))
            .unwrap_err();
        assert!(error.to_string().contains("declared byte length"));
    }

    #[test]
    fn rejects_invalid_base64() {
        let mut decoder = RpcFrameDecoder::default();
        let error = decoder
            .push_value(json!({
                "type": "rpc_chunk",
                "chunkId": "a",
                "index": 0,
                "count": 1,
                "byteLength": 4,
                "data": "****",
            }))
            .unwrap_err();
        assert!(error.to_string().contains("base64"));
    }

    #[test]
    fn rejects_oversized_logical_frame() {
        let mut decoder = RpcFrameDecoder::default();
        let error = decoder
            .push_value(json!({
                "type": "rpc_chunk",
                "chunkId": "a",
                "index": 0,
                "count": 1,
                "byteLength": MAX_RPC_REASSEMBLED_BYTES + 1,
                "data": "e30=",
            }))
            .unwrap_err();
        assert!(error.to_string().contains("logical frame"));
    }

    #[test]
    fn passes_regular_json_frames_through() {
        let mut decoder = RpcFrameDecoder::default();
        let frame = decoder
            .push_line(r#"{"type":"ready"}"#)
            .unwrap()
            .expect("ready frame");
        assert_eq!(frame["type"], "ready");
    }

    #[test]
    fn accepts_max_raw_payload_even_when_base64_is_larger() {
        let mut payload = vec![b' '; RPC_CHUNK_PAYLOAD_BYTES];
        payload[0] = b'{';
        payload[RPC_CHUNK_PAYLOAD_BYTES - 1] = b'}';
        let bytes = [payload.as_slice(), br#"{"type":"ready"}"#].concat();
        let mut decoder = RpcFrameDecoder::default();
        assert!(
            decoder
                .push_value(chunk_part(
                    "a",
                    0,
                    2,
                    bytes.len(),
                    &bytes[..RPC_CHUNK_PAYLOAD_BYTES]
                ))
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn rejects_single_oversized_chunk_payload() {
        let bytes = vec![b'x'; RPC_CHUNK_PAYLOAD_BYTES + 1];
        let mut decoder = RpcFrameDecoder::default();
        let error = decoder
            .push_value(chunk_frame("a", 0, 1, &bytes))
            .unwrap_err();
        assert!(error.to_string().contains("payload"));
    }
}

use std::{env, fs, sync::Once};

use anyhow::{Context, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

use crate::{AppState, ServerMessage, VoiceSessionHandle};

const OPENAI_REALTIME_TRANSCRIPTION_URL: &str =
    "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_TRANSCRIPTION_MODEL: &str = "gpt-4o-mini-transcribe";
const VOICE_TRANSCRIPTION_API_KEY_ENV: &str = "FURA_VOICE_OPENAI_API_KEY";
const MAX_AUDIO_CHUNK_BASE64_BYTES: usize = 1_000_000;

#[derive(Debug)]
pub(crate) enum VoiceCommand {
    Audio(String),
    Stop,
}

pub(crate) async fn start_voice_session(
    state: &AppState,
    client_id: String,
    language: Option<String>,
) -> Vec<ServerMessage> {
    let api_key = match voice_openai_api_key() {
        Ok(api_key) => api_key,
        Err(error) => {
            return vec![ServerMessage::VoiceError {
                target_client_id: client_id,
                message: error.to_string(),
            }];
        }
    };

    stop_existing_voice_session(state, &client_id).await;

    let run_id = Uuid::new_v4().to_string();
    let (commands, command_rx) = mpsc::channel(128);
    state.voice_sessions.write().await.insert(
        client_id.clone(),
        VoiceSessionHandle {
            commands,
            run_id: run_id.clone(),
        },
    );

    let state_for_task = state.clone();
    let target_client_id = client_id.clone();
    let configured_language = match language.and_then(normalize_language) {
        Some(language) => language,
        None => normalize_language_value(&state.voice_language.read().await),
    };

    tokio::spawn(async move {
        run_openai_realtime_transcription(
            state_for_task,
            target_client_id,
            run_id,
            api_key,
            configured_language,
            command_rx,
        )
        .await;
    });

    vec![ServerMessage::VoiceStatus {
        target_client_id: client_id,
        status: "connecting".to_string(),
        message: Some("Connecting voice transcription.".to_string()),
    }]
}

pub(crate) async fn handle_voice_audio(
    state: &AppState,
    client_id: String,
    audio: String,
) -> Vec<ServerMessage> {
    if audio.len() > MAX_AUDIO_CHUNK_BASE64_BYTES {
        return vec![ServerMessage::VoiceError {
            target_client_id: client_id,
            message: "Voice audio chunk is too large.".to_string(),
        }];
    }

    let sessions = state.voice_sessions.read().await;
    let Some(session) = sessions.get(&client_id) else {
        return Vec::new();
    };

    if session
        .commands
        .send(VoiceCommand::Audio(audio))
        .await
        .is_err()
    {
        return vec![ServerMessage::VoiceError {
            target_client_id: client_id,
            message: "Voice transcription session is no longer active.".to_string(),
        }];
    }

    Vec::new()
}

pub(crate) async fn stop_voice_session(state: &AppState, client_id: String) -> Vec<ServerMessage> {
    match stop_existing_voice_session(state, &client_id).await {
        Some(()) => vec![ServerMessage::VoiceStatus {
            target_client_id: client_id,
            status: "stopping".to_string(),
            message: Some("Finishing voice transcription.".to_string()),
        }],
        None => Vec::new(),
    }
}

async fn stop_existing_voice_session(state: &AppState, client_id: &str) -> Option<()> {
    let handle = state.voice_sessions.write().await.remove(client_id)?;
    let _ = handle.commands.send(VoiceCommand::Stop).await;
    Some(())
}

async fn run_openai_realtime_transcription(
    state: AppState,
    target_client_id: String,
    run_id: String,
    api_key: String,
    language: String,
    mut command_rx: mpsc::Receiver<VoiceCommand>,
) {
    if let Err(error) = run_openai_realtime_transcription_inner(
        &state,
        &target_client_id,
        &api_key,
        &language,
        &mut command_rx,
    )
    .await
    {
        let _ = state
            .events
            .emit(
                &state,
                ServerMessage::VoiceError {
                    target_client_id: target_client_id.clone(),
                    message: error.to_string(),
                },
            )
            .await;
    }

    remove_voice_session_if_current(&state, &target_client_id, &run_id).await;
}

async fn run_openai_realtime_transcription_inner(
    state: &AppState,
    target_client_id: &str,
    api_key: &str,
    language: &str,
    command_rx: &mut mpsc::Receiver<VoiceCommand>,
) -> anyhow::Result<()> {
    install_rustls_crypto_provider();
    let mut request = OPENAI_REALTIME_TRANSCRIPTION_URL
        .into_client_request()
        .context("failed to build OpenAI Realtime request")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}")
            .parse()
            .context("failed to build OpenAI authorization header")?,
    );
    request.headers_mut().insert(
        "OpenAI-Beta",
        "realtime=v1"
            .parse()
            .context("failed to build OpenAI beta header")?,
    );

    let (mut ws, _) = connect_async(request)
        .await
        .context("failed to connect to OpenAI Realtime transcription")?;

    let session_update = json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm16",
            "input_audio_transcription": {
                "model": OPENAI_TRANSCRIPTION_MODEL,
                "language": language,
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500,
            },
            "input_audio_noise_reduction": {
                "type": "near_field",
            },
        },
    });
    ws.send(Message::Text(session_update.to_string().into()))
        .await
        .context("failed to configure OpenAI transcription session")?;
    wait_for_transcription_session_update(&mut ws).await?;

    let _ = state
        .events
        .emit(
            state,
            ServerMessage::VoiceStatus {
                target_client_id: target_client_id.to_string(),
                status: "listening".to_string(),
                message: Some("Hold to dictate. Release to finish.".to_string()),
            },
        )
        .await;

    let mut sent_audio = false;
    let mut stopping = false;

    loop {
        tokio::select! {
            command = command_rx.recv(), if !stopping => {
                match command {
                    Some(VoiceCommand::Audio(audio)) => {
                        if audio.is_empty() {
                            continue;
                        }
                        sent_audio = true;
                        let event = json!({
                            "type": "input_audio_buffer.append",
                            "audio": audio,
                        });
                        ws.send(Message::Text(event.to_string().into()))
                            .await
                            .context("failed to send audio to OpenAI")?;
                    }
                    Some(VoiceCommand::Stop) | None => {
                        stopping = true;
                        if sent_audio {
                            let commit = json!({ "type": "input_audio_buffer.commit" });
                            ws.send(Message::Text(commit.to_string().into()))
                                .await
                                .context("failed to commit OpenAI audio buffer")?;
                        } else {
                            let _ = state
                                .events
                                .emit(
                                    state,
                                    ServerMessage::VoiceStatus {
                                        target_client_id: target_client_id.to_string(),
                                        status: "idle".to_string(),
                                        message: Some("No voice audio captured.".to_string()),
                                    },
                                )
                                .await;
                            break;
                        }
                    }
                }
            }
            frame = ws.next() => {
                let Some(frame) = frame else {
                    if stopping {
                        break;
                    }
                    return Err(anyhow!("OpenAI transcription stream closed"));
                };
                let frame = frame.context("failed to read OpenAI transcription event")?;
                if handle_openai_message(state, target_client_id, &frame, stopping).await? {
                    break;
                }
            }
        }
    }

    let _ = ws.close(None).await;
    Ok(())
}

async fn wait_for_transcription_session_update<S>(ws: &mut S) -> anyhow::Result<()>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let Some(frame) = ws.next().await else {
            return Err(anyhow!(
                "OpenAI transcription stream closed before session update completed"
            ));
        };
        let frame = frame.context("failed to read OpenAI session update response")?;
        let Message::Text(text) = frame else {
            continue;
        };
        let event: Value = serde_json::from_str(&text)
            .context("failed to parse OpenAI session update response")?;
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
        {
            "transcription_session.updated" => return Ok(()),
            "error" => return Err(anyhow!(openai_error_message(&event))),
            _ => {}
        }
    }
}

async fn handle_openai_message(
    state: &AppState,
    target_client_id: &str,
    frame: &Message,
    stopping: bool,
) -> anyhow::Result<bool> {
    let Message::Text(text) = frame else {
        return Ok(false);
    };
    let event: Value = serde_json::from_str(text).context("failed to parse OpenAI event")?;
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    match event_type {
        "conversation.item.input_audio_transcription.delta" => {
            if let Some(delta) = event
                .get("delta")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                let _ = state
                    .events
                    .emit(
                        state,
                        ServerMessage::VoiceDelta {
                            target_client_id: target_client_id.to_string(),
                            item_id: openai_item_id(&event),
                            text: delta.to_string(),
                        },
                    )
                    .await;
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let transcript = event
                .get("transcript")
                .and_then(Value::as_str)
                .unwrap_or("");
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::VoiceFinal {
                        target_client_id: target_client_id.to_string(),
                        item_id: openai_item_id(&event),
                        text: transcript.to_string(),
                    },
                )
                .await;
            if stopping {
                let _ = state
                    .events
                    .emit(
                        state,
                        ServerMessage::VoiceStatus {
                            target_client_id: target_client_id.to_string(),
                            status: "idle".to_string(),
                            message: Some("Voice transcription finished.".to_string()),
                        },
                    )
                    .await;
                return Ok(true);
            }
        }
        "conversation.item.input_audio_transcription.failed" => {
            let message = openai_error_message(&event);
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::VoiceError {
                        target_client_id: target_client_id.to_string(),
                        message: message.to_string(),
                    },
                )
                .await;
            return Ok(true);
        }
        "input_audio_buffer.speech_started" => {
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::VoiceStatus {
                        target_client_id: target_client_id.to_string(),
                        status: "listening".to_string(),
                        message: Some("Listening.".to_string()),
                    },
                )
                .await;
        }
        "input_audio_buffer.speech_stopped" | "input_audio_buffer.committed" => {
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::VoiceStatus {
                        target_client_id: target_client_id.to_string(),
                        status: "transcribing".to_string(),
                        message: Some("Transcribing.".to_string()),
                    },
                )
                .await;
        }
        "error" => {
            let message = openai_error_message(&event);
            let lower_message = message.to_ascii_lowercase();
            if stopping
                && lower_message.contains("buffer")
                && (lower_message.contains("empty") || lower_message.contains("too small"))
            {
                let _ = state
                    .events
                    .emit(
                        state,
                        ServerMessage::VoiceStatus {
                            target_client_id: target_client_id.to_string(),
                            status: "idle".to_string(),
                            message: Some("Voice transcription finished.".to_string()),
                        },
                    )
                    .await;
                return Ok(true);
            }
            return Err(anyhow!(message.to_string()));
        }
        _ => {}
    }

    Ok(false)
}

async fn remove_voice_session_if_current(state: &AppState, client_id: &str, run_id: &str) {
    let mut sessions = state.voice_sessions.write().await;
    if sessions
        .get(client_id)
        .map(|handle| handle.run_id.as_str() == run_id)
        .unwrap_or(false)
    {
        sessions.remove(client_id);
    }
}

fn openai_item_id(event: &Value) -> String {
    event
        .get("item_id")
        .and_then(Value::as_str)
        .filter(|item_id| !item_id.is_empty())
        .unwrap_or("current")
        .to_string()
}

fn openai_error_message(event: &Value) -> String {
    event
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("OpenAI Realtime transcription error")
        .to_string()
}

fn normalize_language(language: String) -> Option<String> {
    let trimmed = language.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        trimmed
            .split(['-', '_'])
            .next()
            .unwrap_or(trimmed)
            .to_ascii_lowercase(),
    )
}

fn normalize_language_value(language: &str) -> String {
    language
        .trim()
        .split(['-', '_'])
        .next()
        .filter(|language| !language.is_empty())
        .unwrap_or("pl")
        .to_ascii_lowercase()
}

fn install_rustls_crypto_provider() {
    static INSTALL_PROVIDER: Once = Once::new();
    INSTALL_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn voice_openai_api_key() -> anyhow::Result<String> {
    if let Some(api_key) = env::var(VOICE_TRANSCRIPTION_API_KEY_ENV)
        .ok()
        .and_then(non_empty_string)
    {
        return Ok(api_key);
    }

    let env_path = env::current_dir()
        .context("failed to locate bridge working directory")?
        .join(".env");
    let env_text = fs::read_to_string(&env_path).with_context(|| {
        format!(
            "{VOICE_TRANSCRIPTION_API_KEY_ENV} missing from environment and failed to read {}",
            env_path.display()
        )
    })?;

    resolve_voice_openai_api_key(None, &env_text, &env_path)
}

fn resolve_voice_openai_api_key(
    env_api_key: Option<String>,
    dotenv_text: &str,
    env_path: &std::path::Path,
) -> anyhow::Result<String> {
    if let Some(api_key) = env_api_key.and_then(non_empty_string) {
        return Ok(api_key);
    }

    parse_dotenv_key(dotenv_text, VOICE_TRANSCRIPTION_API_KEY_ENV).ok_or_else(|| {
        anyhow!(
            "{VOICE_TRANSCRIPTION_API_KEY_ENV} missing from environment or {}",
            env_path.display()
        )
    })
}

fn parse_dotenv_key(text: &str, key: &str) -> Option<String> {
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((candidate_key, value)) = line.split_once('=') else {
            continue;
        };
        if candidate_key.trim() != key {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if let Some(value) = non_empty_string(value.to_string()) {
            return Some(value);
        }
    }
    None
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn resolve_voice_key_uses_fura_scoped_env_var() {
        let key = resolve_voice_openai_api_key(
            Some("  fura-voice-key  ".to_string()),
            "OPENAI_API_KEY=wrong-account",
            Path::new(".env"),
        )
        .expect("scoped voice key should resolve");

        assert_eq!(key, "fura-voice-key");
    }

    #[test]
    fn resolve_voice_key_uses_fura_scoped_dotenv_key() {
        let key = resolve_voice_openai_api_key(
            None,
            "OPENAI_API_KEY=wrong-account\nFURA_VOICE_OPENAI_API_KEY=fura-voice-key",
            Path::new(".env"),
        )
        .expect("scoped dotenv voice key should resolve");

        assert_eq!(key, "fura-voice-key");
    }

    #[test]
    fn resolve_voice_key_rejects_unscoped_openai_key() {
        let error =
            resolve_voice_openai_api_key(None, "OPENAI_API_KEY=wrong-account", Path::new(".env"))
                .expect_err("unscoped OpenAI key must not be used for Fura voice");

        assert!(error.to_string().contains(VOICE_TRANSCRIPTION_API_KEY_ENV));
        assert!(!error.to_string().starts_with("OPENAI_API_KEY "));
    }

    #[test]
    fn parse_dotenv_key_skips_malformed_lines() {
        let key = parse_dotenv_key(
            "not a dotenv assignment\nFURA_VOICE_OPENAI_API_KEY='fura-voice-key'",
            VOICE_TRANSCRIPTION_API_KEY_ENV,
        )
        .expect("key after malformed line should still be parsed");

        assert_eq!(key, "fura-voice-key");
    }
}

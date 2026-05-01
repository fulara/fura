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
    let api_key = match openai_api_key() {
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
        let _ = state.events.send(ServerMessage::VoiceError {
            target_client_id: target_client_id.clone(),
            message: error.to_string(),
        });
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
    });
    ws.send(Message::Text(session_update.to_string().into()))
        .await
        .context("failed to configure OpenAI transcription session")?;

    let _ = state.events.send(ServerMessage::VoiceStatus {
        target_client_id: target_client_id.to_string(),
        status: "listening".to_string(),
        message: Some("Hold to dictate. Release to finish.".to_string()),
    });

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
                            let _ = state.events.send(ServerMessage::VoiceStatus {
                                target_client_id: target_client_id.to_string(),
                                status: "idle".to_string(),
                                message: Some("No voice audio captured.".to_string()),
                            });
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
                let _ = state.events.send(ServerMessage::VoiceDelta {
                    target_client_id: target_client_id.to_string(),
                    item_id: openai_item_id(&event),
                    text: delta.to_string(),
                });
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let transcript = event
                .get("transcript")
                .and_then(Value::as_str)
                .unwrap_or("");
            let _ = state.events.send(ServerMessage::VoiceFinal {
                target_client_id: target_client_id.to_string(),
                item_id: openai_item_id(&event),
                text: transcript.to_string(),
            });
            if stopping {
                let _ = state.events.send(ServerMessage::VoiceStatus {
                    target_client_id: target_client_id.to_string(),
                    status: "idle".to_string(),
                    message: Some("Voice transcription finished.".to_string()),
                });
                return Ok(true);
            }
        }
        "conversation.item.input_audio_transcription.failed" => {
            let message = event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("OpenAI transcription failed");
            let _ = state.events.send(ServerMessage::VoiceError {
                target_client_id: target_client_id.to_string(),
                message: message.to_string(),
            });
            return Ok(true);
        }
        "input_audio_buffer.speech_started" => {
            let _ = state.events.send(ServerMessage::VoiceStatus {
                target_client_id: target_client_id.to_string(),
                status: "listening".to_string(),
                message: Some("Listening.".to_string()),
            });
        }
        "input_audio_buffer.speech_stopped" | "input_audio_buffer.committed" => {
            let _ = state.events.send(ServerMessage::VoiceStatus {
                target_client_id: target_client_id.to_string(),
                status: "transcribing".to_string(),
                message: Some("Transcribing.".to_string()),
            });
        }
        "error" => {
            let message = event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("OpenAI Realtime transcription error");
            if stopping
                && message.to_ascii_lowercase().contains("buffer")
                && message.to_ascii_lowercase().contains("empty")
            {
                let _ = state.events.send(ServerMessage::VoiceStatus {
                    target_client_id: target_client_id.to_string(),
                    status: "idle".to_string(),
                    message: Some("Voice transcription finished.".to_string()),
                });
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

fn openai_api_key() -> anyhow::Result<String> {
    if let Some(api_key) = env::var("OPENAI_API_KEY").ok().and_then(non_empty_string) {
        return Ok(api_key);
    }

    let env_path = env::current_dir()
        .context("failed to locate bridge working directory")?
        .join(".env");
    let env_text = fs::read_to_string(&env_path).with_context(|| {
        format!(
            "OPENAI_API_KEY missing from environment and failed to read {}",
            env_path.display()
        )
    })?;

    parse_dotenv_key(&env_text, "OPENAI_API_KEY").ok_or_else(|| {
        anyhow!(
            "OPENAI_API_KEY missing from environment or {}",
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
        let (candidate_key, value) = line.split_once('=')?;
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

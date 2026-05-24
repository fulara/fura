use anyhow::{Context, ensure};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::fs as async_fs;
use tracing::warn;
use x509_parser::pem::Pem;

use crate::{AppState, ServerMessage, SessionMode};

#[derive(Debug, Parser)]
#[command(
    name = "fura",
    version,
    about = "Local browser bridge for Oh My Pi RPC sessions"
)]
pub(crate) struct Args {
    #[arg(long, default_value = "127.0.0.1:3737")]
    pub(crate) bind: SocketAddr,

    #[arg(long, env = "FURA_REMOTE_BIND")]
    pub(crate) remote_bind: Option<SocketAddr>,

    /// Public HTTPS host name used by remote browser clients. Must match the TLS certificate host name.
    #[arg(long, env = "FURA_REMOTE_HOST")]
    pub(crate) remote_host: Option<String>,

    /// Additional exact browser Origin values allowed for the remote HTTPS listener.
    #[arg(
        long = "allowed-origin",
        env = "FURA_ALLOWED_ORIGINS",
        value_delimiter = ','
    )]
    pub(crate) allowed_origins: Vec<String>,

    #[arg(long, env = "FURA_TLS_CERT")]
    pub(crate) tls_cert: Option<PathBuf>,

    #[arg(long, env = "FURA_TLS_KEY")]
    pub(crate) tls_key: Option<PathBuf>,

    #[arg(long, env = "FURA_TOKEN")]
    pub(crate) token: Option<String>,

    #[arg(long, env = "FURA_LOG_FRAMES", default_value_t = false)]
    pub(crate) log_frames: bool,

    /// JSONL file that receives every raw RPC stdout frame before Fura maps it.
    #[arg(long, env = "FURA_BRIDGE_DEBUG_FILE")]
    pub(crate) bridge_debug_file: Option<PathBuf>,

    /// Compact JSONL event log with large text fields truncated for diagnosis.
    #[arg(long, env = "FURA_EVENT_DEBUG_FILE")]
    pub(crate) event_debug_file: Option<PathBuf>,

    /// Forward raw OMP RPC frames to WebSocket clients. Disabled by default because clients do not render them.
    #[arg(long, env = "FURA_FORWARD_RAW_FRAMES", default_value_t = false)]
    pub(crate) forward_raw_frames: bool,

    #[arg(long, default_value = "frontend/dist")]
    pub(crate) static_dir: PathBuf,

    /// Program used for each managed stdio JSONL RPC child.
    #[arg(long, env = "FURA_RPC_PROGRAM", default_value = "omp")]
    pub(crate) rpc_program: String,

    /// Extra argument for the RPC child. Repeat for multiple args.
    #[arg(long = "rpc-arg", env = "FURA_RPC_ARGS")]
    pub(crate) rpc_args: Vec<String>,

    /// Do not add the default Oh My Pi RPC args (`--mode rpc`).
    #[arg(long, env = "FURA_NO_DEFAULT_RPC_ARGS", default_value_t = false)]
    pub(crate) no_default_rpc_args: bool,

    /// Root directory containing OMP session JSONL files.
    #[arg(long, env = "FURA_SESSION_ROOT")]
    pub(crate) session_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteListenerConfig {
    pub(crate) bind: SocketAddr,
    pub(crate) host: String,
    pub(crate) cert_path: PathBuf,
    pub(crate) key_path: PathBuf,
    pub(crate) allowed_origins: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ThinkingVisibilityPreference {
    Auto,
    Shown,
    Hidden,
}

impl Default for ThinkingVisibilityPreference {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProposedThinkingLevel {
    Default,
    Off,
    Minimal,
    Low,
    Medium,
    High,
}

impl Default for ProposedThinkingLevel {
    fn default() -> Self {
        Self::Default
    }
}

impl ProposedThinkingLevel {
    pub(crate) fn as_rpc_level(self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::Off => Some("off"),
            Self::Minimal => Some("minimal"),
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
        }
    }
}

pub(crate) fn is_default_proposed_thinking_level(level: &ProposedThinkingLevel) -> bool {
    *level == ProposedThinkingLevel::Default
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProposedModelConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) provider: String,
    #[serde(alias = "model-id")]
    pub(crate) model_id: String,
    #[serde(default, alias = "model-name", skip_serializing_if = "Option::is_none")]
    pub(crate) model_name: Option<String>,
    #[serde(default, alias = "thinking-level")]
    pub(crate) thinking_level: ProposedThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct FuraConfig {
    pub(crate) last_cwd: Option<String>,
    #[serde(default = "default_voice_language")]
    pub(crate) voice_language: String,
    #[serde(default = "default_show_tools")]
    pub(crate) show_tools: bool,
    #[serde(default = "default_thinking_visibility")]
    pub(crate) thinking_visibility: ThinkingVisibilityPreference,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(crate) session_categories: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(crate) session_modes: HashMap<String, SessionMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) proposed_models: Vec<ProposedModelConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct FuraConfigDisk<'a> {
    last_cwd: &'a Option<String>,
    voice_language: &'a String,
    show_tools: bool,
    thinking_visibility: ThinkingVisibilityPreference,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    session_categories: &'a HashMap<String, String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    session_modes: &'a HashMap<String, SessionMode>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    proposed_models: Vec<ProposedModelDisk<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ProposedModelDisk<'a> {
    id: &'a String,
    name: &'a String,
    provider: &'a String,
    model_id: &'a String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_name: &'a Option<String>,
    #[serde(skip_serializing_if = "is_default_proposed_thinking_level")]
    thinking_level: ProposedThinkingLevel,
}

fn serialize_fura_config_for_disk(config: &FuraConfig) -> serde_yaml::Result<String> {
    let proposed_models = config
        .proposed_models
        .iter()
        .map(|model| ProposedModelDisk {
            id: &model.id,
            name: &model.name,
            provider: &model.provider,
            model_id: &model.model_id,
            model_name: &model.model_name,
            thinking_level: model.thinking_level,
        })
        .collect();
    serde_yaml::to_string(&FuraConfigDisk {
        last_cwd: &config.last_cwd,
        voice_language: &config.voice_language,
        show_tools: config.show_tools,
        thinking_visibility: config.thinking_visibility,
        session_categories: &config.session_categories,
        session_modes: &config.session_modes,
        proposed_models,
    })
}

impl Default for FuraConfig {
    fn default() -> Self {
        Self {
            last_cwd: None,
            voice_language: default_voice_language(),
            show_tools: default_show_tools(),
            thinking_visibility: default_thinking_visibility(),
            session_categories: HashMap::new(),
            session_modes: HashMap::new(),
            proposed_models: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientConfig {
    pub(crate) default_cwd: String,
    pub(crate) voice_language: String,
    pub(crate) show_tools: bool,
    pub(crate) thinking_visibility: ThinkingVisibilityPreference,
    pub(crate) proposed_models: Vec<ProposedModelConfig>,
}

pub(crate) fn default_voice_language() -> String {
    "pl-PL".to_string()
}

pub(crate) fn default_show_tools() -> bool {
    true
}

pub(crate) fn default_thinking_visibility() -> ThinkingVisibilityPreference {
    ThinkingVisibilityPreference::Auto
}

pub(crate) fn validate_proposed_models(models: &[ProposedModelConfig]) -> anyhow::Result<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for model in models {
        ensure!(
            is_valid_proposed_model_id(&model.id),
            "proposed model id must contain lowercase letters/digits separated by single dashes: {}",
            model.id
        );
        ensure!(
            !model.name.trim().is_empty(),
            "proposed model name is required"
        );
        ensure!(
            !model.provider.trim().is_empty(),
            "proposed model provider is required for {}",
            model.name
        );
        ensure!(
            !model.model_id.trim().is_empty(),
            "proposed model id is required for {}",
            model.name
        );
        ensure!(
            ids.insert(model.id.clone()),
            "duplicate proposed model id: {}",
            model.id
        );
        let normalized_name = model.name.trim().to_lowercase();
        ensure!(
            names.insert(normalized_name),
            "duplicate proposed model name: {}",
            model.name
        );
    }
    Ok(())
}

pub(crate) fn normalize_proposed_models(
    models: Vec<ProposedModelConfig>,
) -> Vec<ProposedModelConfig> {
    models
        .into_iter()
        .map(|model| ProposedModelConfig {
            id: model.id.trim().to_string(),
            name: model.name.trim().to_string(),
            provider: model.provider.trim().to_string(),
            model_id: model.model_id.trim().to_string(),
            model_name: model.model_name.and_then(|name| {
                let trimmed = name.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            }),
            thinking_level: model.thinking_level,
        })
        .collect()
}

pub(crate) fn is_valid_proposed_model_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.first() == Some(&b'-') || bytes.last() == Some(&b'-') {
        return false;
    }
    let mut previous_dash = false;
    for byte in bytes {
        let valid = byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-';
        if !valid {
            return false;
        }
        if *byte == b'-' {
            if previous_dash {
                return false;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
    }
    true
}

const MIN_REMOTE_CERT_VALIDITY: Duration = Duration::from_secs(5 * 24 * 60 * 60);

pub(crate) fn local_bind_url(bind: SocketAddr) -> String {
    format!("http://{bind}/")
}

pub(crate) fn remote_listener_from_args(
    remote_bind: Option<SocketAddr>,
    remote_host: Option<&str>,
    tls_cert: Option<&Path>,
    tls_key: Option<&Path>,
    configured_allowed_origins: Vec<String>,
) -> anyhow::Result<Option<RemoteListenerConfig>> {
    let remote_parts_present = remote_bind.is_some()
        || remote_host.is_some()
        || tls_cert.is_some()
        || tls_key.is_some()
        || !configured_allowed_origins.is_empty();
    if !remote_parts_present {
        return Ok(None);
    }

    let bind = remote_bind
        .ok_or_else(|| anyhow::anyhow!("--remote-bind is required when remote TLS is enabled"))?;
    let host =
        normalize_remote_host(remote_host.ok_or_else(|| {
            anyhow::anyhow!("--remote-host is required when remote TLS is enabled")
        })?)
        .ok_or_else(|| {
            anyhow::anyhow!("--remote-host must be a bare host name or IP without scheme/path")
        })?;
    let cert_path = tls_cert
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("--tls-cert is required when remote TLS is enabled"))?;
    let key_path = tls_key
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("--tls-key is required when remote TLS is enabled"))?;
    ensure!(
        cert_path != key_path,
        "--tls-cert and --tls-key must point to different files"
    );

    let mut allowed_origins = vec![remote_origin(&host, bind.port())];
    for origin in configured_allowed_origins {
        if let Some(origin) = normalize_allowed_origin(&origin) {
            if !allowed_origins.contains(&origin) {
                allowed_origins.push(origin);
            }
        }
    }

    Ok(Some(RemoteListenerConfig {
        bind,
        host,
        cert_path,
        key_path,
        allowed_origins,
    }))
}

pub(crate) fn validate_remote_cert_expiry(remote: &RemoteListenerConfig) -> anyhow::Result<()> {
    let cert_bytes = fs::read(&remote.cert_path)
        .with_context(|| format!("failed to read TLS cert {}", remote.cert_path.display()))?;
    let mut cert_count = 0usize;
    for pem in Pem::iter_from_buffer(&cert_bytes) {
        let pem = pem.with_context(|| {
            format!(
                "failed to parse PEM block in {}",
                remote.cert_path.display()
            )
        })?;
        let cert = pem.parse_x509().with_context(|| {
            format!(
                "failed to parse X.509 certificate in {}",
                remote.cert_path.display()
            )
        })?;
        cert_count += 1;
        ensure!(
            cert.validity().is_valid(),
            "TLS cert {} is not currently valid",
            remote.cert_path.display()
        );
        let remaining = cert.validity().time_to_expiration().ok_or_else(|| {
            anyhow::anyhow!(
                "TLS cert {} does not report a usable expiration time",
                remote.cert_path.display()
            )
        })?;
        ensure!(
            remaining >= MIN_REMOTE_CERT_VALIDITY,
            "TLS cert {} expires in less than 5 days",
            remote.cert_path.display()
        );
    }
    ensure!(
        cert_count > 0,
        "TLS cert {} does not contain any PEM certificate blocks",
        remote.cert_path.display()
    );
    Ok(())
}

pub(crate) fn normalize_allowed_origin(origin: &str) -> Option<String> {
    let trimmed = origin.trim().trim_end_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn remote_origin(host: &str, port: u16) -> String {
    format!("https://{}:{port}", format_public_host(host))
}

pub(crate) fn remote_url(host: &str, port: u16) -> String {
    format!("{}/", remote_origin(host, port))
}

pub(crate) fn normalize_remote_host(host: &str) -> Option<String> {
    let trimmed = host.trim().trim_end_matches('/').trim_end_matches('.');
    if trimmed.is_empty() || trimmed.contains("://") || trimmed.contains('/') {
        return None;
    }
    Some(trimmed.to_string())
}

fn format_public_host(host: &str) -> String {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return origin_host(ip);
    }
    host.to_string()
}

fn origin_host(host: IpAddr) -> String {
    match host {
        IpAddr::V4(host) => host.to_string(),
        IpAddr::V6(host) => format!("[{host}]"),
    }
}

pub(crate) fn default_config_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".fura").join("config.yaml"))
}

pub(crate) fn valid_directory_string(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    match fs::metadata(trimmed) {
        Ok(metadata) if metadata.is_dir() => Some(trimmed.to_string()),
        _ => None,
    }
}

pub(crate) fn load_fura_config(config_path: Option<&Path>) -> FuraConfig {
    let Some(path) = config_path else {
        return FuraConfig::default();
    };

    match fs::read_to_string(path) {
        Ok(text) => match serde_yaml::from_str::<FuraConfig>(&text) {
            Ok(mut config) => {
                config.proposed_models = normalize_proposed_models(config.proposed_models);
                if let Err(error) = validate_proposed_models(&config.proposed_models) {
                    warn!(path = %path.display(), %error, "invalid proposed models in Fura config");
                    config.proposed_models.clear();
                }
                config
            }
            Err(error) => {
                warn!(path = %path.display(), %error, "failed to parse Fura config");
                FuraConfig::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => FuraConfig::default(),
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to read Fura config");
            FuraConfig::default()
        }
    }
}

#[cfg(test)]
pub(crate) fn load_default_cwd(config_path: Option<&Path>, startup_cwd: &Path) -> String {
    default_cwd_from_config(&load_fura_config(config_path), startup_cwd)
}

pub(crate) fn default_cwd_from_config(config: &FuraConfig, startup_cwd: &Path) -> String {
    if let Some(cwd) = config.last_cwd.as_deref().and_then(valid_directory_string) {
        return cwd;
    }

    startup_cwd.to_string_lossy().into_owned()
}

pub(crate) async fn client_config(state: &AppState) -> ClientConfig {
    ClientConfig {
        default_cwd: state.default_cwd.read().await.clone(),
        voice_language: state.voice_language.read().await.clone(),
        show_tools: *state.show_tools.read().await,
        thinking_visibility: *state.thinking_visibility.read().await,
        proposed_models: state.proposed_models.read().await.clone(),
    }
}

pub(crate) async fn broadcast_config(state: &AppState) {
    let config = client_config(state).await;
    let _ = state.events.send(ServerMessage::ConfigUpdated { config });
}

pub(crate) async fn save_fura_config(state: &AppState) -> anyhow::Result<()> {
    let Some(path) = state.config_path.as_ref() else {
        return Ok(());
    };

    if let Some(parent) = path.parent() {
        async_fs::create_dir_all(parent).await.with_context(|| {
            format!(
                "failed to create Fura config directory {}",
                parent.display()
            )
        })?;
    }

    let config = FuraConfig {
        last_cwd: Some(state.default_cwd.read().await.clone()),
        voice_language: state.voice_language.read().await.clone(),
        show_tools: *state.show_tools.read().await,
        thinking_visibility: *state.thinking_visibility.read().await,
        session_categories: state.session_runtime.session_categories_snapshot().await,
        session_modes: state.session_runtime.session_modes_snapshot().await,
        proposed_models: state.proposed_models.read().await.clone(),
    };
    let text =
        serialize_fura_config_for_disk(&config).context("failed to serialize Fura config")?;
    async_fs::write(path, text)
        .await
        .with_context(|| format!("failed to write Fura config {}", path.display()))?;
    Ok(())
}

pub(crate) async fn save_default_cwd(state: &AppState, cwd: &str) {
    *state.default_cwd.write().await = cwd.to_string();

    if let Err(error) = save_fura_config(state).await {
        warn!(%error, "failed to save default cwd");
    }
    broadcast_config(state).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{CertificateParams, KeyPair};
    use tempfile::tempdir;
    use time::{Duration as TimeDuration, OffsetDateTime};

    fn write_test_cert(path: &Path, not_after: OffsetDateTime) {
        let mut params =
            CertificateParams::new(vec!["serwer-mini.caracal-porgy.ts.net".to_string()])
                .expect("params");
        params.not_before = OffsetDateTime::now_utc() - TimeDuration::days(1);
        params.not_after = not_after;
        let key = KeyPair::generate().expect("key");
        let cert = params.self_signed(&key).expect("cert");
        fs::write(path, cert.pem()).expect("write cert");
    }

    #[test]
    fn local_bind_url_formats_socket_addr() {
        assert_eq!(
            local_bind_url("127.0.0.1:3737".parse().expect("socket")),
            "http://127.0.0.1:3737/"
        );
    }

    #[test]
    fn remote_listener_requires_all_tls_fields_when_enabled() {
        let error = remote_listener_from_args(
            Some("100.117.222.49:4450".parse().expect("socket")),
            Some("serwer-mini.caracal-porgy.ts.net"),
            None,
            None,
            Vec::new(),
        )
        .expect_err("missing tls fields should fail");

        assert!(
            error
                .to_string()
                .contains("--tls-cert is required when remote TLS is enabled")
        );
    }

    #[test]
    fn remote_listener_builds_https_origin_and_deduplicates_extras() {
        let remote = remote_listener_from_args(
            Some("100.117.222.49:4450".parse().expect("socket")),
            Some("serwer-mini.caracal-porgy.ts.net."),
            Some(Path::new("cert.pem")),
            Some(Path::new("key.pem")),
            vec![
                " https://serwer-mini.caracal-porgy.ts.net:4450/ ".to_string(),
                "https://alt.tailnet.ts.net:4450".to_string(),
            ],
        )
        .expect("config should parse")
        .expect("remote config should exist");

        assert_eq!(remote.host, "serwer-mini.caracal-porgy.ts.net");
        assert_eq!(
            remote.allowed_origins,
            vec![
                "https://serwer-mini.caracal-porgy.ts.net:4450".to_string(),
                "https://alt.tailnet.ts.net:4450".to_string(),
            ]
        );
        assert_eq!(
            remote_url(&remote.host, remote.bind.port()),
            "https://serwer-mini.caracal-porgy.ts.net:4450/"
        );
    }

    #[test]
    fn normalize_remote_host_rejects_scheme_and_path() {
        assert_eq!(normalize_remote_host("https://host.example"), None);
        assert_eq!(normalize_remote_host("host.example/path"), None);
        assert_eq!(
            normalize_remote_host(" serwer-mini.caracal-porgy.ts.net. "),
            Some("serwer-mini.caracal-porgy.ts.net".to_string())
        );
    }

    #[test]
    fn validate_remote_cert_expiry_accepts_cert_with_more_than_five_days_left() {
        let dir = tempdir().expect("tempdir");
        let cert_path = dir.path().join("cert.pem");
        write_test_cert(
            &cert_path,
            OffsetDateTime::now_utc() + TimeDuration::days(6),
        );
        let remote = RemoteListenerConfig {
            bind: "100.117.222.49:4450".parse().expect("socket"),
            host: "serwer-mini.caracal-porgy.ts.net".to_string(),
            cert_path,
            key_path: dir.path().join("key.pem"),
            allowed_origins: vec!["https://serwer-mini.caracal-porgy.ts.net:4450".to_string()],
        };

        validate_remote_cert_expiry(&remote).expect("cert should be accepted");
    }

    #[test]
    fn validate_remote_cert_expiry_rejects_cert_with_less_than_five_days_left() {
        let dir = tempdir().expect("tempdir");
        let cert_path = dir.path().join("cert.pem");
        write_test_cert(
            &cert_path,
            OffsetDateTime::now_utc() + TimeDuration::days(4),
        );
        let remote = RemoteListenerConfig {
            bind: "100.117.222.49:4450".parse().expect("socket"),
            host: "serwer-mini.caracal-porgy.ts.net".to_string(),
            cert_path,
            key_path: dir.path().join("key.pem"),
            allowed_origins: vec!["https://serwer-mini.caracal-porgy.ts.net:4450".to_string()],
        };

        let error = validate_remote_cert_expiry(&remote).expect_err("cert should be rejected");
        assert!(error.to_string().contains("expires in less than 5 days"));
    }

    #[test]
    fn fura_config_defaults_to_no_proposed_models() {
        let config = serde_yaml::from_str::<FuraConfig>("show-tools: true\n").expect("config");

        assert!(config.proposed_models.is_empty());
    }

    #[test]
    fn fura_config_omits_empty_proposed_models() {
        let text =
            serialize_fura_config_for_disk(&FuraConfig::default()).expect("serialize config");

        assert!(!text.contains("proposed-models"));
    }

    #[test]
    fn proposed_model_default_thinking_is_omitted() {
        let config = FuraConfig {
            proposed_models: vec![ProposedModelConfig {
                id: "fast-review".to_string(),
                name: "Fast review".to_string(),
                provider: "cursor".to_string(),
                model_id: "gpt-5.2-codex".to_string(),
                model_name: Some("GPT-5.2 Codex".to_string()),
                thinking_level: ProposedThinkingLevel::Default,
            }],
            ..FuraConfig::default()
        };

        let text = serialize_fura_config_for_disk(&config).expect("serialize config");

        assert!(text.contains("proposed-models:"));
        assert!(text.contains("model-id: gpt-5.2-codex"));
        assert!(!text.contains("thinking-level"));
    }

    #[test]
    fn proposed_model_non_default_thinking_serializes_lowercase() {
        let config = FuraConfig {
            proposed_models: vec![ProposedModelConfig {
                id: "fast-review".to_string(),
                name: "Fast review".to_string(),
                provider: "cursor".to_string(),
                model_id: "gpt-5.2-codex".to_string(),
                model_name: None,
                thinking_level: ProposedThinkingLevel::High,
            }],
            ..FuraConfig::default()
        };

        let text = serialize_fura_config_for_disk(&config).expect("serialize config");

        assert!(text.contains("thinking-level: high"));
    }

    #[test]
    fn proposed_model_parse_keeps_model_id_slashes() {
        let config = serde_yaml::from_str::<FuraConfig>(
            r#"
proposed-models:
  - id: fast-review
    name: Fast review
    provider: openrouter
    model-id: anthropic/claude-sonnet-4.5
    thinking-level: low
"#,
        )
        .expect("config");

        assert_eq!(config.proposed_models[0].provider, "openrouter");
        assert_eq!(
            config.proposed_models[0].model_id,
            "anthropic/claude-sonnet-4.5"
        );
        assert_eq!(
            config.proposed_models[0].thinking_level,
            ProposedThinkingLevel::Low
        );
    }

    #[test]
    fn validate_proposed_models_rejects_bad_ids_and_duplicates() {
        let valid = ProposedModelConfig {
            id: "fast-one".to_string(),
            name: "Fast one".to_string(),
            provider: "cursor".to_string(),
            model_id: "gpt-5.2-codex".to_string(),
            model_name: None,
            thinking_level: ProposedThinkingLevel::Default,
        };
        validate_proposed_models(std::slice::from_ref(&valid)).expect("valid model");

        let mut bad = valid.clone();
        bad.id = "Fast One".to_string();
        assert!(validate_proposed_models(&[bad]).is_err());

        let duplicate = ProposedModelConfig {
            id: valid.id.clone(),
            name: "Other".to_string(),
            ..valid.clone()
        };
        assert!(validate_proposed_models(&[valid.clone(), duplicate]).is_err());

        let duplicate_name = ProposedModelConfig {
            id: "other".to_string(),
            name: valid.name.clone(),
            ..valid.clone()
        };
        assert!(validate_proposed_models(&[valid, duplicate_name]).is_err());
    }

    #[test]
    fn normalize_proposed_models_trims_fields_and_drops_empty_cached_name() {
        let normalized = normalize_proposed_models(vec![ProposedModelConfig {
            id: " fast-review ".to_string(),
            name: " Fast review ".to_string(),
            provider: " mock ".to_string(),
            model_id: " mock-model ".to_string(),
            model_name: Some("   ".to_string()),
            thinking_level: ProposedThinkingLevel::Default,
        }]);

        assert_eq!(normalized[0].id, "fast-review");
        assert_eq!(normalized[0].name, "Fast review");
        assert_eq!(normalized[0].provider, "mock");
        assert_eq!(normalized[0].model_id, "mock-model");
        assert_eq!(normalized[0].model_name, None);
    }
}

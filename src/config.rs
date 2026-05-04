use anyhow::{Context, ensure};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::fs as async_fs;
use tracing::warn;
use x509_parser::pem::Pem;

use crate::{AppState, ServerMessage};

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
}

impl Default for FuraConfig {
    fn default() -> Self {
        Self {
            last_cwd: None,
            voice_language: default_voice_language(),
            show_tools: default_show_tools(),
            thinking_visibility: default_thinking_visibility(),
            session_categories: HashMap::new(),
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
            Ok(config) => config,
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
    }
}

pub(crate) async fn broadcast_config(state: &AppState) {
    let config = client_config(state).await;
    let _ = state.events.send(ServerMessage::ConfigUpdated { config });
}

pub(crate) async fn save_fura_config(state: &AppState) {
    let Some(path) = state.config_path.as_ref() else {
        return;
    };

    if let Some(parent) = path.parent() {
        if let Err(error) = async_fs::create_dir_all(parent).await {
            warn!(path = %parent.display(), %error, "failed to create Fura config directory");
            return;
        }
    }

    let config = FuraConfig {
        last_cwd: Some(state.default_cwd.read().await.clone()),
        voice_language: state.voice_language.read().await.clone(),
        show_tools: *state.show_tools.read().await,
        thinking_visibility: *state.thinking_visibility.read().await,
        session_categories: state.session_categories.read().await.clone(),
    };
    match serde_yaml::to_string(&config) {
        Ok(text) => {
            if let Err(error) = async_fs::write(path, text).await {
                warn!(path = %path.display(), %error, "failed to write Fura config");
            }
        }
        Err(error) => warn!(%error, "failed to serialize Fura config"),
    }
}

pub(crate) async fn save_default_cwd(state: &AppState, cwd: &str) {
    *state.default_cwd.write().await = cwd.to_string();

    save_fura_config(state).await;
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
}

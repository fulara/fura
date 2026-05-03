use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    net::IpAddr,
    path::{Path, PathBuf},
};
use tokio::fs as async_fs;
use tracing::warn;

use crate::{AppState, ServerMessage};

#[derive(Debug, Parser)]
#[command(
    name = "fura",
    version,
    about = "Local browser bridge for Oh My Pi RPC sessions"
)]
pub(crate) struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    pub(crate) host: IpAddr,

    #[arg(long, default_value_t = 3737)]
    pub(crate) port: u16,

    /// Allowed browser Origin values for WebSocket handshakes. Repeat or pass comma-separated values via FURA_ALLOWED_ORIGINS.
    #[arg(
        long = "allowed-origin",
        env = "FURA_ALLOWED_ORIGINS",
        value_delimiter = ','
    )]
    pub(crate) allowed_origins: Vec<String>,

    /// Hostname or Tailscale IP shown as the mobile URL and added to allowed browser origins. Does not change the bind address.
    #[arg(long, env = "FURA_MOBILE_HOST")]
    pub(crate) mobile_host: Option<String>,

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct FuraConfig {
    pub(crate) last_cwd: Option<String>,
    #[serde(default = "default_voice_language")]
    pub(crate) voice_language: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(crate) session_categories: HashMap<String, String>,
}

impl Default for FuraConfig {
    fn default() -> Self {
        Self {
            last_cwd: None,
            voice_language: default_voice_language(),
            session_categories: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientConfig {
    pub(crate) default_cwd: String,
    pub(crate) voice_language: String,
}

pub(crate) fn default_voice_language() -> String {
    "pl-PL".to_string()
}

pub(crate) fn allowed_origins_from_args(
    host: IpAddr,
    port: u16,
    configured: Vec<String>,
    mobile_host: Option<&str>,
) -> Vec<String> {
    let mut origins = default_allowed_origins(host, port);
    for origin in configured {
        if let Some(origin) = normalize_allowed_origin(&origin) {
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
    }
    if let Some(origin) = mobile_origin(mobile_host, port) {
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

pub(crate) fn default_allowed_origins(host: IpAddr, port: u16) -> Vec<String> {
    let mut origins = vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ];
    if host.is_loopback() {
        let host_origin = format!("http://{}:{port}", origin_host(host));
        if !origins.contains(&host_origin) {
            origins.push(host_origin);
        }
    }
    origins
}

pub(crate) fn normalize_allowed_origin(origin: &str) -> Option<String> {
    let trimmed = origin.trim().trim_end_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn mobile_origin(mobile_host: Option<&str>, port: u16) -> Option<String> {
    let host = normalize_mobile_host(mobile_host?)?;
    Some(format!("http://{host}:{port}"))
}

pub(crate) fn mobile_url(mobile_host: Option<&str>, port: u16) -> Option<String> {
    mobile_origin(mobile_host, port).map(|origin| format!("{origin}/"))
}

pub(crate) fn normalize_mobile_host(host: &str) -> Option<String> {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains("://") || trimmed.contains('/') {
        return None;
    }
    Some(trimmed.to_string())
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

    #[test]
    fn default_allowed_origins_include_loopback_browser_origins() {
        let origins = default_allowed_origins("127.0.0.1".parse().expect("ip"), 3737);

        assert!(origins.contains(&"http://127.0.0.1:3737".to_string()));
        assert!(origins.contains(&"http://localhost:3737".to_string()));
        assert_eq!(origins.len(), 2);
    }

    #[test]
    fn configured_allowed_origins_are_trimmed_and_deduplicated() {
        let origins = allowed_origins_from_args(
            "127.0.0.1".parse().expect("ip"),
            3737,
            vec![
                " http://phone.tailnet.ts.net:3737/ ".to_string(),
                "http://phone.tailnet.ts.net:3737".to_string(),
            ],
            None,
        );

        assert_eq!(
            origins
                .iter()
                .filter(|origin| origin.as_str() == "http://phone.tailnet.ts.net:3737")
                .count(),
            1,
        );
    }

    #[test]
    fn mobile_host_adds_allowed_origin() {
        let origins = allowed_origins_from_args(
            "127.0.0.1".parse().expect("ip"),
            3737,
            Vec::new(),
            Some("desktop.tailnet.ts.net"),
        );

        assert!(origins.contains(&"http://desktop.tailnet.ts.net:3737".to_string()));
    }

    #[test]
    fn mobile_host_rejects_full_urls() {
        assert_eq!(
            mobile_origin(Some("http://desktop.tailnet.ts.net"), 3737),
            None
        );
        assert_eq!(mobile_url(Some("desktop.tailnet.ts.net/path"), 3737), None);
    }
}

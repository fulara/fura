use std::{
    env, fs,
    net::IpAddr,
    path::{Path, PathBuf},
};

use clap::Parser;
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct FuraConfig {
    pub(crate) last_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientConfig {
    pub(crate) default_cwd: String,
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

pub(crate) fn load_default_cwd(config_path: Option<&Path>, startup_cwd: &Path) -> String {
    if let Some(path) = config_path {
        match fs::read_to_string(path) {
            Ok(text) => match serde_yaml::from_str::<FuraConfig>(&text) {
                Ok(config) => {
                    if let Some(cwd) = config.last_cwd.as_deref().and_then(valid_directory_string) {
                        return cwd;
                    }
                }
                Err(error) => warn!(path = %path.display(), %error, "failed to parse Fura config"),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warn!(path = %path.display(), %error, "failed to read Fura config"),
        }
    }

    startup_cwd.to_string_lossy().into_owned()
}

pub(crate) async fn client_config(state: &AppState) -> ClientConfig {
    ClientConfig {
        default_cwd: state.default_cwd.read().await.clone(),
    }
}

pub(crate) async fn broadcast_config(state: &AppState) {
    let config = client_config(state).await;
    let _ = state.events.send(ServerMessage::ConfigUpdated { config });
}

pub(crate) async fn save_default_cwd(state: &AppState, cwd: &str) {
    *state.default_cwd.write().await = cwd.to_string();

    if let Some(path) = state.config_path.as_ref() {
        if let Some(parent) = path.parent() {
            if let Err(error) = async_fs::create_dir_all(parent).await {
                warn!(path = %parent.display(), %error, "failed to create Fura config directory");
                broadcast_config(state).await;
                return;
            }
        }

        let config = FuraConfig {
            last_cwd: Some(cwd.to_string()),
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
    broadcast_config(state).await;
}

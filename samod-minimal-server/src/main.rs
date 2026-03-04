//! Minimal samod WebSocket sync server for bug reproduction.
//!
//! This is a stripped-down server that uses samod with DontAnnounce policy.
//! It exists solely to reproduce a bug in samod-core where documents synced
//! by a client are lost because `handle_load` transitions to `NotFound`
//! before processing pending sync messages.
//!
//! Usage:
//!   cargo run -- --port 18300 --data-dir /tmp/samod-test

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use clap::Parser;
use samod::Repo;
use samod::storage::TokioFilesystemStorage;
use tokio::net::TcpListener;
use tracing::info;

#[derive(Parser)]
struct Args {
    /// Port to listen on
    #[arg(long, default_value = "3000")]
    port: u16,

    /// Directory for automerge document storage
    #[arg(long)]
    data_dir: PathBuf,
}

#[derive(Clone)]
struct AppState {
    repo: Arc<Repo>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();

    // Create storage directory if it doesn't exist
    tokio::fs::create_dir_all(&args.data_dir)
        .await
        .expect("Failed to create data directory");

    // Initialize samod repo with DontAnnounce policy (the trigger for the bug)
    let storage = TokioFilesystemStorage::new(&args.data_dir);
    let repo = Repo::build_tokio()
        .with_storage(storage)
        .with_announce_policy(|_doc_id, _peer_id| false)
        .load()
        .await;

    let state = AppState {
        repo: Arc::new(repo),
    };

    let router = Router::new()
        .route("/", get(ws_handler))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", args.port);
    let listener = TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    // This line is matched by the test harness to detect readiness
    info!(addr = %addr, "samod-minimal-server listening");

    axum::serve(listener, router).await.expect("Server error");
}

async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_websocket(socket, state))
}

async fn handle_websocket(socket: WebSocket, state: AppState) {
    match state.repo.accept_axum(socket) {
        Ok(connection) => {
            info!(peer_info = ?connection.info(), "Client connected");
            let reason = connection.finished().await;
            info!(peer_info = ?connection.info(), reason = ?reason, "Client disconnected");
        }
        Err(samod::Stopped) => {
            tracing::warn!("WebSocket rejected: repo is stopped");
        }
    }
}

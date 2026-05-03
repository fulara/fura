// fura-gui: native desktop window for a running Fura server.
//
// Opens the browser frontend in a native window. Authentication uses the same in-page
// bridge token entry flow as browser clients; the token is never placed in the URL.
//
// Usage:
//   fura-gui
//   fura-gui --host 127.0.0.1 --port 3737

use anyhow::Context;
use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "fura-gui", about = "Native desktop window for a Fura server")]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 3737)]
    port: u16,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let url = format!("http://{}:{}/", args.host, args.port);
    open_window(url)
}

#[cfg(target_os = "linux")]
fn open_window(url: String) -> anyhow::Result<()> {
    #[allow(unused_imports)]
    use gtk::prelude::*;
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        platform::unix::WindowExtUnix,
        window::WindowBuilder,
    };
    use wry::WebViewBuilderExtUnix;

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Fura")
        .with_inner_size(LogicalSize::new(1280u32, 800u32))
        .build(&event_loop)
        .context("failed to create window")?;

    let vbox = window
        .default_vbox()
        .context("tao window has no default vbox")?;
    let _webview = wry::WebViewBuilder::new()
        .with_url(url)
        .build_gtk(vbox)
        .context("failed to create webview");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            std::process::exit(0);
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn open_window(url: String) -> anyhow::Result<()> {
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        window::WindowBuilder,
    };

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Fura")
        .with_inner_size(LogicalSize::new(1280u32, 800u32))
        .build(&event_loop)
        .context("failed to create window")?;

    let _webview = wry::WebViewBuilder::new()
        .with_url(url)
        .build(&window)
        .context("failed to create webview")?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            std::process::exit(0);
        }
    });
}

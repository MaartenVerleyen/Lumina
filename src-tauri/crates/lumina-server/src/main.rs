// lumina-server: Lumina's engine without a window, for a home server (Linux in Docker, or Windows).
// It keeps its libraries scanned, with thumbnails, faces and smart search. Clients connect to it from
// Lumina 5.0 on (the API is not here yet).
mod config;
mod host;
mod pipeline;

use config::Config;
use host::ServerHost;
use lumina_core::host::Host;
use lumina_core::{ai, backup, db, libraries, watch};
use pipeline::Pipeline;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const USAGE: &str = "\
Usage: lumina-server [--config FILE] COMMAND

Commands:
  serve                     Bring every library up to date, then keep it so as files change (Ctrl+C stops)
  scan [FOLDER...]          Bring the given folders (default: the configured libraries) up to date and stop
  libraries                 List the libraries in the database
  restore-backup FILE [--map FROM=TO]...
                            Put a .luminabackup in place of the database (paths under FROM move to TO)

The configuration file defaults to ./lumina-server.toml. LUMINA_DATA_DIR, LUMINA_LIBRARIES (separated by ;),
LUMINA_OLLAMA_URL and LUMINA_CAPTION_MODEL override it.";

#[tokio::main]
async fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut config_path = None;
    if let Some(i) = args.iter().position(|a| a == "--config") {
        if i + 1 >= args.len() {
            fail("--config needs a file");
        }
        config_path = Some(PathBuf::from(args.remove(i + 1)));
        args.remove(i);
    }
    let Some(command) = args.first().cloned() else {
        println!("{USAGE}");
        return;
    };
    let rest = &args[1..];
    let config = Config::load(config_path.as_deref()).unwrap_or_else(|e| fail(&e));
    if let Some(url) = &config.ollama_url {
        ai::set_ollama_url(url);
    }
    let host = Arc::new(ServerHost::new(config.data_dir()));
    println!("Lumina server · data in {}", host.data_dir().display());

    let result = match command.as_str() {
        "serve" => serve(&config, host).await,
        "scan" => {
            let folders = if rest.is_empty() { config.libraries.clone() } else { rest.to_vec() };
            scan(&config, host, &folders).await
        }
        "libraries" => list_libraries(&host),
        "restore-backup" => restore(host, rest).await,
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        other => Err(format!("Unknown command: {other}\n\n{USAGE}")),
    };
    if let Err(e) = result {
        fail(&e);
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

fn pipeline(config: &Config, host: Arc<ServerHost>) -> Pipeline {
    Pipeline { host, caption_model: config.caption_model.clone() }
}

async fn scan(config: &Config, host: Arc<ServerHost>, folders: &[String]) -> Result<(), String> {
    if folders.is_empty() {
        return Err("No folders: name them, or list them as `libraries` in the configuration file".to_string());
    }
    let pipeline = pipeline(config, host);
    for folder in folders {
        pipeline.update_library(&libraries::normalize_root(folder)).await?;
    }
    Ok(())
}

async fn serve(config: &Config, host: Arc<ServerHost>) -> Result<(), String> {
    let roots: Vec<String> = config.libraries.iter().map(|r| libraries::normalize_root(r)).collect();
    if roots.is_empty() {
        return Err("No libraries to serve: list them as `libraries` in the configuration file".to_string());
    }
    let mut changes = host.subscribe();
    let pipeline = pipeline(config, host.clone());
    for root in &roots {
        if let Err(e) = pipeline.update_library(root).await {
            eprintln!("[library] {root}: {e}");
        }
    }
    watch::watch_libraries(host.clone(), roots.clone())?;
    println!("Watching {} for changes (Ctrl+C stops)", roots.join(", "));

    // Changes are collected for a few seconds, so a copy of 500 files is one update, not 500
    let mut pending: BTreeSet<String> = BTreeSet::new();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("Stopping");
                return Ok(());
            }
            event = changes.recv() => {
                if let Ok((name, payload)) = event {
                    if name == "library-files-changed" {
                        if let Some(root) = payload.as_str() {
                            pending.insert(root.to_string());
                        }
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(5)), if !pending.is_empty() => {
                for root in std::mem::take(&mut pending) {
                    if let Err(e) = pipeline.update_library(&root).await {
                        eprintln!("[library] {root}: {e}");
                    }
                }
                // What the updates themselves stirred up is not a change to the library
                changes = changes.resubscribe();
            }
        }
    }
}

fn list_libraries(host: &ServerHost) -> Result<(), String> {
    let conn = db::open_global_db(host)?;
    let all = libraries::list(&conn)?;
    if all.is_empty() {
        println!("No libraries yet: `scan FOLDER` adds one");
    }
    for l in all {
        println!("{:>8} photos  {}", l.photos, l.root);
    }
    Ok(())
}

async fn restore(host: Arc<ServerHost>, args: &[String]) -> Result<(), String> {
    let mut file = None;
    let mut remaps = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--map" {
            let (from, to) = args
                .get(i + 1)
                .and_then(|m| m.split_once('='))
                .ok_or("--map needs FROM=TO")?;
            remaps.push(backup::RootRemap { from: from.to_string(), to: to.to_string() });
            i += 2;
        } else {
            file = Some(args[i].clone());
            i += 1;
        }
    }
    let file = file.ok_or("restore-backup needs the .luminabackup file")?;
    let manifest = backup::inspect_backup(file.clone()).await?;
    for root in &manifest.roots {
        println!("Backup library: {} ({} photos)", root.path, root.photos);
    }
    let result = backup::restore_library(host.clone(), file, remaps).await?;
    backup::apply_pending_restore(&host.data_dir());
    println!("Restored {} photos ({} moved to new folders). Run `scan` or `serve` next.", result.photos, result.remapped);
    Ok(())
}

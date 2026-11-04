// lumina-server: Lumina's engine without a window, for a home server (Linux in Docker, or Windows).
// It keeps its libraries scanned, with thumbnails, faces and smart search, and serves the web client and
// the engine's commands to logged-in users (http).
mod accounts;
mod changes;
mod config;
mod dynamic;
mod host;
mod http;
mod pipeline;
mod restore;
mod scope;
mod throttle;

use config::Config;
use host::ServerHost;
use lumina_core::host::Host;
use lumina_core::{ai, backup, db, libraries, watch};
use pipeline::Pipeline;
use std::collections::BTreeSet;
use std::io::BufRead;
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

Accounts (roles, lowest first: guest, viewer, uploader, editor, admin):
  users                     List the users, their roles, and their roles per library
  create-user NAME --role ROLE [--password-stdin]
                            ROLE is the default for every library; admin is the whole server
  set-password NAME [--password-stdin]
                            A new password also logs the user out everywhere
  set-role NAME ROLE        The default role
  set-library-role NAME ROOT ROLE|default
                            A different role on one library (default: back to the user's own role)
  remove-user NAME
  A guest sees only the albums shared with them (shared in the app, from the album's menu).
  The password is asked twice, without echo; --password-stdin reads one line from standard input instead.

The configuration file defaults to ./lumina-server.toml. LUMINA_DATA_DIR, LUMINA_LIBRARIES (separated by ;),
LUMINA_OLLAMA_URL, LUMINA_CAPTION_MODEL, LUMINA_LISTEN, LUMINA_WEB_DIR and LUMINA_UPLOAD_LIBRARY override it.";

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
    // Before anything creates the data folder
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("{USAGE}");
        return;
    }
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
        "users" | "create-user" | "set-password" | "set-role" | "set-library-role" | "remove-user" => {
            account_command(&host, &command, rest)
        }
        "restore-backup" => restore(host, rest).await,
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
    // A restore staged from the admin page goes in before anything opens the database
    match restore::apply_staged(&host, &roots) {
        Ok(true) => println!("[restore] the restored library is in place"),
        Ok(false) => {}
        Err(e) => eprintln!("[restore] {e}"),
    }
    host.jobs.set_caption_model(config.caption_model.clone());
    // The web server first, so people can log in while a long first scan runs
    start_web_server(config, host.clone()).await?;
    // Shared dynamic albums follow the library as it changes
    dynamic::keep_up(host.clone());

    let mut changes = host.subscribe();
    let mut jobs = host.jobs.take_receiver().ok_or("The pipeline runs once per server")?;
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
            Some(job) = jobs.recv() => {
                println!("[job] {}", job.describe());
                if let Err(e) = pipeline.run(job).await {
                    eprintln!("[job] {e}");
                }
                changes = changes.resubscribe();
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
    restore::apply_staged(&host, &[])?;
    println!("Restored {} photos ({} moved to new folders). Run `scan` or `serve` next.", result.photos, result.remapped);
    Ok(())
}

async fn start_web_server(config: &Config, host: Arc<ServerHost>) -> Result<(), String> {
    let users = {
        let conn = db::open_global_db(&*host)?;
        accounts::ensure_tables(&conn)?;
        accounts::list_users(&conn)?.len()
    };
    let listen = config.listen();
    let web_dir = config.web_dir();
    let listener = tokio::net::TcpListener::bind(&listen).await.map_err(|e| format!("Can't listen on {listen}: {e}"))?;
    match &web_dir {
        Some(dir) => println!("Web: http://{listen} (web client from {})", dir.display()),
        None => println!("Web: http://{listen} (no web client found: set web_dir or LUMINA_WEB_DIR)"),
    }
    if users == 0 {
        println!("No users yet: `lumina-server create-user NAME --role admin` adds the first one");
    }
    let state = Arc::new(http::AppState { host, web_dir, throttle: Default::default(), upload_library: config.upload_library.clone() });
    let app = http::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[http] the web server stopped: {e}");
        }
    });
    Ok(())
}

// A password from the terminal (twice, without echo) or, with --password-stdin, one line of standard input
fn read_password(from_stdin: bool) -> Result<String, String> {
    if from_stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map_err(|e| e.to_string())?;
        return Ok(line.trim_end_matches(['\r', '\n']).to_string());
    }
    let first = rpassword::prompt_password("Password: ").map_err(|e| e.to_string())?;
    let second = rpassword::prompt_password("Password again: ").map_err(|e| e.to_string())?;
    if first != second {
        return Err("The two passwords differ".to_string());
    }
    Ok(first)
}

fn account_command(host: &ServerHost, command: &str, args: &[String]) -> Result<(), String> {
    let conn = db::open_global_db(host)?;
    accounts::ensure_tables(&conn)?;
    let password_stdin = args.iter().any(|a| a == "--password-stdin");
    let mut words = Vec::new();
    let mut role = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--password-stdin" => {}
            "--role" => {
                role = Some(accounts::Role::parse(args.get(i + 1).ok_or("--role needs a role")?)?);
                i += 1;
            }
            other => words.push(other.to_string()),
        }
        i += 1;
    }
    let name = || words.first().cloned().ok_or_else(|| format!("{command} needs a user name"));
    match command {
        "users" => {
            let users = accounts::list_users(&conn)?;
            if users.is_empty() {
                println!("No users yet: `create-user NAME --role admin` adds one");
            }
            let roots: std::collections::HashMap<i64, String> =
                libraries::list(&conn)?.into_iter().map(|l| (l.id, l.root)).collect();
            for u in users {
                println!("{:<8} {}", u.role.as_str(), u.name);
                for (library, role) in scope::library_roles_of(&conn, u.id)? {
                    println!("{:<8}   {} on {}", "", role.as_str(), roots.get(&library).map(String::as_str).unwrap_or("(a removed library)"));
                }
            }
        }
        "create-user" => {
            let name = name()?;
            let role = role.ok_or("create-user needs --role (guest, viewer, uploader, editor or admin)")?;
            let password = read_password(password_stdin)?;
            let user = accounts::create_user(&conn, &name, role, &password)?;
            println!("Created {} ({})", user.name, user.role.as_str());
        }
        "set-password" => {
            let name = name()?;
            let password = read_password(password_stdin)?;
            accounts::set_password(&conn, &name, &password)?;
            println!("New password for {name}; their sessions are logged out");
        }
        "set-role" => {
            let name = name()?;
            let role = words.get(1).map(|r| accounts::Role::parse(r)).or(role.map(Ok)).ok_or("set-role needs NAME ROLE")??;
            accounts::set_role(&conn, &name, role)?;
            println!("{name} is now {}", role.as_str());
        }
        "set-library-role" => {
            let (Some(name), Some(root), Some(role)) = (words.first(), words.get(1), words.get(2)) else {
                return Err("set-library-role needs NAME ROOT ROLE (or default)".into());
            };
            let user = accounts::find_user(&conn, name)?.ok_or_else(|| format!("No user called {name}"))?;
            let wanted = libraries::normalize_root(root);
            let library = libraries::list(&conn)?
                .into_iter()
                .find(|l| libraries::normalize_root(&l.root) == wanted)
                .ok_or_else(|| format!("{root} isn't one of the server's libraries (see `libraries`)"))?;
            let role = if role == "default" { None } else { Some(accounts::Role::parse(role)?) };
            scope::set_library_role(&conn, user.id, library.id, role)?;
            match role {
                Some(r) => println!("{} is {} on {}", user.name, r.as_str(), library.root),
                None => println!("{} has their own role ({}) on {} again", user.name, user.role.as_str(), library.root),
            }
        }
        "remove-user" => {
            let name = name()?;
            accounts::remove_user(&conn, &name)?;
            println!("Removed {name}");
        }
        _ => unreachable!(),
    }
    Ok(())
}

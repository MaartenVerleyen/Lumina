// lumina-tray: a tray icon on the server's own computer. It shows whether lumina-server is running and what
// it is doing (indexing 12,000 of 50,000, about 20 min left), opens the admin page, and starts and stops the
// server: as a systemd service on Linux, through docker compose, or as a program of its own on Windows.
//
// It asks the server at /local/status with the key the server writes in its data folder when it starts
// (local-access.key), so it needs no account; it finds the data folder and the address the way the server
// does (lumina-server.toml, LUMINA_DATA_DIR, LUMINA_LISTEN).
#![cfg_attr(windows, windows_subsystem = "windows")]

use serde_json::Value as JsonValue;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

const USAGE: &str = "\
Usage: lumina-tray [OPTIONS]

  --config FILE      The server's lumina-server.toml (default: ./lumina-server.toml), for its data folder and address
  --data-dir DIR     The server's data folder (where it writes local-access.key)
  --url URL          Where the server answers on this computer (default: http://<listen>, 127.0.0.1:8080)
  --admin-url URL    The page to open for Open admin page (default: the server's address with #admin)

How Start and Stop work (default: the systemd user service lumina-server on Linux, lumina-server.exe next to
the tray on Windows):
  --service NAME     A systemd service; add --system for a system service rather than a user one
  --compose FILE     docker compose with this file (Start: up -d, Stop: stop). The tray then reads the key
                     from the container (docker compose exec), unless --data-dir names a folder it can read
  --compose-service NAME
                     The server's service in that file (default: lumina)
  --start CMD --stop CMD
                     Commands of your own, run by the shell";

// Where the key the server writes at each start comes from
#[derive(Clone)]
enum KeySource {
    File(PathBuf),
    // Docker: the data folder is the container's (a volume only root can read), so the key is read in there
    Container { compose: PathBuf, service: String },
}

// docker exec and systemctl from a tray on Windows: no console window flashing up
fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn read_key(source: &KeySource) -> Option<String> {
    let key = match source {
        KeySource::File(path) => std::fs::read_to_string(path).ok()?,
        KeySource::Container { compose, service } => {
            let out = quiet(Command::new("docker").args(["compose", "-f", &compose.to_string_lossy(), "exec", "-T", service, "cat", "/data/local-access.key"]))
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            String::from_utf8(out.stdout).ok()?
        }
    };
    Some(key.trim().to_string()).filter(|k| !k.is_empty())
}

#[derive(Clone)]
enum Control {
    Systemd { unit: String, system: bool },
    Compose(PathBuf),
    // lumina-server started and stopped by the tray itself
    Child { exe: PathBuf, config: Option<PathBuf> },
    Custom { start: String, stop: String },
}

struct Options {
    status_url: String,
    admin_url: String,
    key: KeySource,
    control: Control,
}

fn options() -> Result<Options, String> {
    let mut args = std::env::args().skip(1);
    let (mut config, mut data_dir, mut url, mut admin_url) = (None, None, None, None);
    let (mut service, mut system, mut compose, mut start, mut stop) = (None, false, None, None, None);
    let mut compose_service = "lumina".to_string();
    while let Some(a) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{a} needs a value"));
        match a.as_str() {
            "--config" => config = Some(PathBuf::from(value()?)),
            "--data-dir" => data_dir = Some(PathBuf::from(value()?)),
            "--url" => url = Some(value()?),
            "--admin-url" => admin_url = Some(value()?),
            "--service" => service = Some(value()?),
            "--system" => system = true,
            "--compose" => compose = Some(PathBuf::from(value()?)),
            "--compose-service" => compose_service = value()?,
            "--start" => start = Some(value()?),
            "--stop" => stop = Some(value()?),
            "-h" | "--help" => return Err(USAGE.to_string()),
            other => return Err(format!("Unknown option {other}\n\n{USAGE}")),
        }
    }

    // The server's own way: the file, then the variables over it
    let file = config.clone().or_else(|| Some(PathBuf::from("lumina-server.toml")).filter(|p| p.exists()));
    let table: toml::Table = match &file {
        Some(f) => toml::from_str(&std::fs::read_to_string(f).map_err(|e| format!("Can't read {}: {e}", f.display()))?)
            .map_err(|e| format!("{}: {e}", f.display()))?,
        None => toml::Table::new(),
    };
    let text = |key: &str| table.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let key = match (&compose, data_dir) {
        (Some(file), None) => KeySource::Container { compose: file.clone(), service: compose_service },
        (_, given) => KeySource::File(
            given
                .or_else(|| var("LUMINA_DATA_DIR").map(PathBuf::from))
                .or_else(|| text("data_dir").map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("lumina-data"))
                .join("local-access.key"),
        ),
    };
    let listen = var("LUMINA_LISTEN").or_else(|| text("listen")).unwrap_or_else(|| "127.0.0.1:8080".to_string());
    // A server listening everywhere answers on this computer at 127.0.0.1
    let local = listen.replace("0.0.0.0", "127.0.0.1").replace("[::]", "127.0.0.1");
    let base = url.unwrap_or_else(|| format!("http://{local}"));
    let base = base.trim_end_matches('/').to_string();

    let shell_pair = start.zip(stop);
    let control = if let Some((start, stop)) = shell_pair {
        Control::Custom { start, stop }
    } else if let Some(file) = compose {
        Control::Compose(file)
    } else if let Some(unit) = service {
        Control::Systemd { unit, system }
    } else if cfg!(windows) {
        let exe = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("lumina-server.exe"))).unwrap_or_default();
        Control::Child { exe, config: file }
    } else {
        Control::Systemd { unit: "lumina-server".to_string(), system }
    };
    Ok(Options {
        status_url: format!("{base}/local/status"),
        admin_url: admin_url.unwrap_or_else(|| format!("{base}/#admin")),
        key,
        control,
    })
}

// Asks the server what it is doing, with the key kept between polls: it changes only when the server starts
// again (then the server refuses the old one, and it is read again)
struct Poller {
    agent: ureq::Agent,
    status_url: String,
    source: KeySource,
    key: Option<String>,
    // Reading it from a container is a process: not more than every 10 s while the server is down
    last_read: Option<std::time::Instant>,
}

enum Answer {
    Status(JsonValue),
    Refused,
    Down,
}

impl Poller {
    fn ask(&self, key: &str) -> Answer {
        let Ok(mut resp) = self.agent.get(&self.status_url).header("x-lumina-local-key", key).call() else {
            return Answer::Down;
        };
        if resp.status().as_u16() == 403 {
            return Answer::Refused;
        }
        if !resp.status().is_success() {
            return Answer::Down;
        }
        match resp.body_mut().read_to_string().ok().and_then(|t| serde_json::from_str(&t).ok()) {
            Some(v) => Answer::Status(v),
            None => Answer::Down,
        }
    }

    fn reread_key(&mut self) -> bool {
        let wait = if matches!(self.source, KeySource::Container { .. }) { Duration::from_secs(10) } else { Duration::ZERO };
        if self.last_read.is_some_and(|t| t.elapsed() < wait) {
            return false;
        }
        self.last_read = Some(std::time::Instant::now());
        self.key = read_key(&self.source);
        self.key.is_some()
    }

    // What the server answered (None: it didn't, or it doesn't take the key)
    fn status(&mut self) -> Option<JsonValue> {
        if self.key.is_none() && !self.reread_key() {
            return None;
        }
        match self.ask(self.key.as_deref()?) {
            Answer::Status(v) => Some(v),
            Answer::Down => None,
            Answer::Refused => {
                // Started again since: a new key
                self.key = None;
                self.last_read = None;
                if !self.reread_key() {
                    return None;
                }
                match self.ask(self.key.as_deref()?) {
                    Answer::Status(v) => Some(v),
                    _ => None,
                }
            }
        }
    }
}

fn count(n: u64) -> String {
    // 12345 -> 12,345
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn time_left(completed: u64, total: u64, seconds: f64) -> Option<String> {
    if total == 0 || completed == 0 || completed >= total || seconds < 5.0 {
        return None;
    }
    let left = (total - completed) as f64 / completed as f64 * seconds;
    Some(if left < 60.0 {
        "less than a minute left".to_string()
    } else if left < 3600.0 {
        format!("about {} min left", (left / 60.0).round())
    } else {
        format!("about {:.1} hours left", left / 3600.0)
    })
}

// The menu's lines about the server, and a short line for the tooltip
fn describe(status: Option<&JsonValue>) -> (Vec<String>, String, State) {
    let Some(s) = status else {
        return (vec!["Lumina server: not running".to_string()], "Lumina server: not running".to_string(), State::Stopped);
    };
    let version = s["version"].as_str().unwrap_or("");
    let mut lines = vec![format!("Lumina server {version}: running")];
    let mut tip = "Lumina server: running".to_string();
    let progress = s["progress"].as_array().cloned().unwrap_or_default();
    for p in &progress {
        let (label, done, total) = (p["label"].as_str().unwrap_or("Working"), p["completed"].as_u64().unwrap_or(0), p["total"].as_u64().unwrap_or(0));
        let mut line = if total > 0 { format!("{label}: {} of {}", count(done), count(total)) } else { format!("{label}: starting") };
        if let Some(left) = time_left(done, total, p["seconds"].as_f64().unwrap_or(0.0)) {
            line.push_str(&format!(" · {left}"));
        }
        if tip.ends_with("running") {
            tip = format!("Lumina server: {line}");
        }
        lines.push(line);
    }
    let jobs = &s["jobs"];
    if progress.is_empty() {
        if let Some(current) = jobs["current"].as_str() {
            lines.push(format!("Working on: {current}"));
        }
    }
    let queued = jobs["queued"].as_array().map(|q| q.len()).unwrap_or(0);
    if queued > 0 {
        lines.push(format!("Waiting: {queued} job{}", if queued == 1 { "" } else { "s" }));
    }
    let busy = !progress.is_empty() || jobs["current"].is_string();
    if lines.len() == 1 {
        lines.push("Nothing to do".to_string());
    }
    (lines, tip, if busy { State::Working } else { State::Idle })
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Stopped,
    Idle,
    Working,
}

// A round icon: green when idle, blue while working, grey when the server doesn't answer
fn icon(state: State) -> Icon {
    let (r, g, b) = match state {
        State::Idle => (52, 211, 153),
        State::Working => (96, 165, 250),
        State::Stopped => (140, 140, 150),
    };
    let size = 32u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    let c = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            // A ring and a dot, like a lens; soft edges
            let ring = (1.0 - (d - 12.5).abs() / 2.5).clamp(0.0, 1.0);
            let dot = (1.0 - (d - 4.5).max(0.0) / 1.2).clamp(0.0, 1.0);
            let a = ring.max(dot);
            rgba.extend_from_slice(&[r, g, b, (a * 255.0) as u8]);
        }
    }
    Icon::from_rgba(rgba, size, size).expect("a 32 x 32 icon")
}

fn shell(command: &str) -> Result<(), String> {
    let status = if cfg!(windows) { Command::new("cmd").args(["/C", command]).status() } else { Command::new("sh").args(["-c", command]).status() };
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("{command} ended with {s}")),
        Err(e) => Err(format!("Can't run {command}: {e}")),
    }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    match Command::new(program).args(args).status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("{program} {} ended with {s}", args.join(" "))),
        Err(e) => Err(format!("Can't run {program}: {e}")),
    }
}

// A system service: first through sudo without a password (the sudoers rule in server/README.md,
// "Upgrading"), else systemctl itself, which asks for the password in a window (polkit)
fn systemctl(system: bool, action: &str, unit: &str) -> Result<(), String> {
    if !system {
        return run("systemctl", &["--user", action, unit]);
    }
    let quiet_sudo = Command::new("sudo").args(["-n", "systemctl", action, unit]).stderr(std::process::Stdio::null()).status();
    if quiet_sudo.is_ok_and(|s| s.success()) {
        return Ok(());
    }
    run("systemctl", &["--system", action, unit])
}

struct Server {
    control: Control,
    child: Option<Child>,
}

impl Server {
    fn start(&mut self) -> Result<(), String> {
        match &self.control {
            Control::Systemd { unit, system } => systemctl(*system, "start", unit),
            Control::Compose(file) => run("docker", &["compose", "-f", &file.to_string_lossy(), "up", "-d"]),
            Control::Custom { start, .. } => shell(start),
            Control::Child { exe, config } => {
                if !exe.is_file() {
                    return Err(format!("There is no {} next to the tray", exe.display()));
                }
                let mut cmd = Command::new(exe);
                if let Some(c) = config {
                    cmd.arg("--config").arg(c);
                }
                cmd.arg("serve");
                if let Some(dir) = exe.parent() {
                    cmd.current_dir(dir);
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    // No console window
                    cmd.creation_flags(0x0800_0000);
                }
                self.child = Some(cmd.spawn().map_err(|e| format!("Can't start {}: {e}", exe.display()))?);
                Ok(())
            }
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        match &self.control {
            Control::Systemd { unit, system } => systemctl(*system, "stop", unit),
            Control::Compose(file) => run("docker", &["compose", "-f", &file.to_string_lossy(), "stop"]),
            Control::Custom { stop, .. } => shell(stop),
            Control::Child { .. } => match self.child.take() {
                Some(mut child) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    Ok(())
                }
                None => Err("The server was started outside the tray: stop it where it was started".to_string()),
            },
        }
    }
}

fn open_in_browser(url: &str) {
    let result = if cfg!(windows) {
        // start's first quoted argument is a window title
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    if let Err(e) = result {
        eprintln!("Can't open {url}: {e}");
    }
}

enum UserEvent {
    Status(Option<JsonValue>),
    Menu(MenuEvent),
}

struct Items {
    admin: MenuItem,
    start: MenuItem,
    stop: MenuItem,
    restart: MenuItem,
    quit: MenuItem,
}

impl Items {
    fn enable(&self, running: bool) {
        self.admin.set_enabled(running);
        self.start.set_enabled(!running);
        self.stop.set_enabled(running);
        self.restart.set_enabled(running);
    }
}

// The menu, with a row per line about the server (returned, so their text can change in place)
fn build_menu(lines: &[String], items: &Items, running: bool) -> (Menu, Vec<MenuItem>) {
    let menu = Menu::new();
    let rows: Vec<MenuItem> = lines.iter().map(|line| MenuItem::new(line, false, None)).collect();
    for row in &rows {
        let _ = menu.append(row);
    }
    let _ = menu.append(&PredefinedMenuItem::separator());
    items.enable(running);
    for item in [&items.admin, &items.start, &items.stop, &items.restart] {
        let _ = menu.append(item);
    }
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&items.quit);
    (menu, rows)
}

// Linux shows tray icons through an app indicator library, loaded when the icon is made; without it the tray
// library panics, which says less than this
#[cfg(target_os = "linux")]
fn appindicator_available() -> bool {
    let names = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];
    let dirs = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib", "/lib64", "/lib/x86_64-linux-gnu"];
    dirs.iter().any(|d| names.iter().any(|n| std::path::Path::new(d).join(n).exists()))
}

fn main() {
    let opts = match options() {
        Ok(o) => o,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(if message == USAGE { 0 } else { 2 });
        }
    };
    #[cfg(target_os = "linux")]
    if !appindicator_available() {
        eprintln!("The tray needs the app indicator library: on Arch `pacman -S libayatana-appindicator`, on Debian or Ubuntu `apt install libayatana-appindicator3-1`");
        std::process::exit(1);
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e| {
        let _ = menu_proxy.send_event(UserEvent::Menu(e));
    }));

    // Asks the server every few seconds, off the event loop
    let mut poller = Poller {
        agent: ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(3))).http_status_as_error(false).build().into(),
        status_url: opts.status_url.clone(),
        source: opts.key.clone(),
        key: None,
        last_read: None,
    };
    std::thread::spawn(move || {
        loop {
            if proxy.send_event(UserEvent::Status(poller.status())).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });

    let items = Items {
        admin: MenuItem::new("Open admin page", true, None),
        start: MenuItem::new("Start server", true, None),
        stop: MenuItem::new("Stop server", true, None),
        restart: MenuItem::new("Restart server", true, None),
        quit: MenuItem::new("Quit tray", true, None),
    };
    let mut server = Server { control: opts.control.clone(), child: None };
    let mut tray: Option<TrayIcon> = None;
    let mut rows: Vec<MenuItem> = Vec::new();
    let mut shown: Option<(Vec<String>, State)> = None;
    let mut problem: Option<String> = None;
    let admin_url = opts.admin_url.clone();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // On Linux the tray can only be made once the event loop (GTK) runs
            Event::NewEvents(StartCause::Init) => {
                let (lines, tip, state) = describe(None);
                let (menu, first_rows) = build_menu(&lines, &items, false);
                rows = first_rows;
                shown = Some((lines, state));
                let made = TrayIconBuilder::new()
                    .with_menu(Box::new(menu))
                    .with_menu_on_left_click(true)
                    .with_tooltip(tip)
                    .with_icon(icon(state))
                    .build();
                match made {
                    Ok(t) => tray = Some(t),
                    Err(e) => {
                        eprintln!("Can't show a tray icon: {e}");
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::UserEvent(UserEvent::Status(status)) => {
                let (mut lines, tip, state) = describe(status.as_ref());
                let running = state != State::Stopped;
                if let Some(p) = &problem {
                    lines.push(p.clone());
                }
                if shown.as_ref() != Some(&(lines.clone(), state)) {
                    if let Some(t) = &tray {
                        // The counts change every few seconds while the server works: the rows' text changes in
                        // place, so an open menu stays open (a new menu would close it, or make it flicker on
                        // Linux); only a different number of rows needs a new menu
                        if rows.len() == lines.len() {
                            for (row, line) in rows.iter().zip(&lines) {
                                row.set_text(line);
                            }
                            items.enable(running);
                        } else {
                            let (menu, new_rows) = build_menu(&lines, &items, running);
                            t.set_menu(Some(Box::new(menu)));
                            rows = new_rows;
                        }
                        // Not shown on Linux (the tray library has no tooltips there): the menu says the same
                        let _ = t.set_tooltip(Some(tip));
                        if shown.as_ref().map(|(_, s)| *s) != Some(state) {
                            let _ = t.set_icon(Some(icon(state)));
                        }
                    }
                    shown = Some((lines, state));
                }
            }
            Event::UserEvent(UserEvent::Menu(e)) => {
                let id = e.id;
                let result = if id == *items.admin.id() {
                    open_in_browser(&admin_url);
                    Ok(())
                } else if id == *items.start.id() {
                    server.start()
                } else if id == *items.stop.id() {
                    server.stop()
                } else if id == *items.restart.id() {
                    server.stop().and_then(|_| {
                        std::thread::sleep(Duration::from_secs(1));
                        server.start()
                    })
                } else if id == *items.quit.id() {
                    // A server the tray started itself stops with it; a service or container keeps running
                    if let Control::Child { .. } = server.control {
                        let _ = server.stop();
                    }
                    tray = None;
                    *control_flow = ControlFlow::Exit;
                    Ok(())
                } else {
                    Ok(())
                };
                problem = result.err();
                // Shown with the next status
                shown = None;
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_time_left_read_well() {
        assert_eq!(count(12345), "12,345");
        assert_eq!(count(999), "999");
        assert_eq!(count(1_000_000), "1,000,000");
        // A fifth done in 5 minutes: 20 more
        assert_eq!(time_left(10_000, 50_000, 300.0).as_deref(), Some("about 20 min left"));
        assert_eq!(time_left(0, 50_000, 300.0), None);
    }

    #[test]
    fn the_menu_shows_the_work_and_the_time_left() {
        let status = serde_json::json!({
            "version": "5.6.0",
            "jobs": { "current": "Update of /photos", "queued": ["Face scan of /photos"] },
            "progress": [{ "label": "Indexing", "stage": "", "completed": 12000, "total": 48000, "seconds": 120.0 }],
        });
        let (lines, tip, state) = describe(Some(&status));
        assert_eq!(
            lines,
            vec![
                "Lumina server 5.6.0: running".to_string(),
                "Indexing: 12,000 of 48,000 · about 6 min left".to_string(),
                "Waiting: 1 job".to_string(),
            ]
        );
        assert_eq!(tip, "Lumina server: Indexing: 12,000 of 48,000 · about 6 min left");
        assert!(state == State::Working);
        let (lines, _, state) = describe(None);
        assert_eq!(lines, vec!["Lumina server: not running".to_string()]);
        assert!(state == State::Stopped);
    }
}

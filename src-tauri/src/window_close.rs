// Closing the main window: ask first, keep Lumina running in the tray, or simply close. The choices are
// settings in the window (Settings → General), passed here whenever they change (set_close_behaviour). The
// question itself is asked by the window (window-close-requested), so it looks like the rest of Lumina; until
// the window has said it asks, closing just closes, so a window that never loaded can still be closed.
use crate::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static ASK: AtomicBool = AtomicBool::new(false);
static TO_TRAY: AtomicBool = AtomicBool::new(false);
#[cfg(desktop)]
const TRAY_ID: &str = "lumina";

pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != "main" {
        return;
    }
    #[cfg(desktop)]
    if TO_TRAY.load(Ordering::Acquire) && window.app_handle().tray_by_id(TRAY_ID).is_some() {
        api.prevent_close();
        let _ = window.hide();
        return;
    }
    if ASK.load(Ordering::Acquire) {
        api.prevent_close();
        let _ = window.emit("window-close-requested", ());
    }
}

// The tray icon is there while "keep running in the tray" is on. Turning it on fails when the tray can't be
// shown (on Linux without the app indicator library): the window then says so and closing keeps closing.
#[tauri::command]
pub fn set_close_behaviour(app: AppHandle, ask: bool, to_tray: bool) -> Result<(), String> {
    ASK.store(ask, Ordering::Release);
    #[cfg(desktop)]
    {
        if to_tray {
            if let Err(e) = ensure_tray(&app) {
                TO_TRAY.store(false, Ordering::Release);
                return Err(e);
            }
        } else {
            let _ = app.remove_tray_by_id(TRAY_ID);
        }
    }
    #[cfg(not(desktop))]
    let _ = &app;
    TO_TRAY.store(to_tray, Ordering::Release);
    Ok(())
}

// Quit, after the window asked (or from the tray)
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// Linux shows tray icons through an app indicator library, loaded when the icon is made; without it the tray
// library panics, which ends the app (release builds abort on a panic)
#[cfg(target_os = "linux")]
fn appindicator_available() -> bool {
    let names = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];
    let dirs = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib", "/lib64", "/lib/x86_64-linux-gnu"];
    dirs.iter().any(|d| names.iter().any(|n| std::path::Path::new(d).join(n).exists()))
}

#[cfg(desktop)]
fn ensure_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if !appindicator_available() {
        return Err("The tray needs the app indicator library (on Arch: pacman -S libayatana-appindicator)".to_string());
    }
    let open = MenuItem::with_id(app, "tray-open", "Open Lumina", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Lumina", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|e| e.to_string())?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Lumina")
        .menu(&menu)
        // A click opens the window; the menu is on the right button (Linux always shows the menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app).map_err(|e| format!("Couldn't show the tray icon: {e}"))?;
    Ok(())
}

use crate::*;


#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("File does not exist on disk".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    #[cfg(target_os = "windows")]
    {
        if p.is_dir() {
            std::process::Command::new("explorer")
                .arg(p.as_os_str())
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(p.as_os_str())
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let target = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn create_library_subfolder(root_folder: String, relative_path: String) -> Result<String, String> {
    let clean_rel = relative_path.trim().replace('\\', "/");
    if clean_rel.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    let mut target = PathBuf::from(&root_folder);
    for part in clean_rel.split('/').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        target = target.join(part);
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}


#[tauri::command]
pub fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Image file does not exist on disk".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let escaped = p.to_string_lossy().replace('\'', "''");
        let ps_cmd = format!(
            "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('{}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()",
            escaped
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Sta", "-Command", &ps_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Failed to copy image to Windows clipboard".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let escaped = p.to_string_lossy().replace('"', "\\\"");
        let script = format!("set the clipboard to (read (POSIX file \"{}\") as JPEG picture)", escaped);
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    }
    Ok(())
}

#[tauri::command]
pub fn close_splashscreen(app: AppHandle) -> Result<(), String> {
    if SPLASH_CLOSED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        if !main_win.is_visible().unwrap_or(false) {
            let _ = main_win.show();
            let _ = main_win.set_focus();
        }
    }
    Ok(())
}

// Embeds Lumina's NSIS installer (the payload Setup runs silently). Taken from $LUMINA_INSTALLER, or else the
// newest one in ../../src-tauri/target/release/bundle/nsis. Without one (UI work) Setup builds with an empty
// payload and reports that it can't install.
use std::{env, fs, path::PathBuf};

fn newest_nsis_installer() -> Option<PathBuf> {
    let dir = PathBuf::from("../../src-tauri/target/release/bundle/nsis");
    fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with("-setup.exe"))
        .max_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
}

fn main() {
    println!("cargo:rerun-if-env-changed=LUMINA_INSTALLER");
    println!("cargo:rerun-if-changed=../../src-tauri/target/release/bundle/nsis");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("payload.exe");
    let payload = env::var_os("LUMINA_INSTALLER").map(PathBuf::from).or_else(newest_nsis_installer);
    match payload {
        Some(p) => {
            println!("cargo:rerun-if-changed={}", p.display());
            fs::copy(&p, &out).expect("copy the Lumina installer");
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            println!("cargo:rustc-env=LUMINA_PAYLOAD_NAME={name}");
        }
        None => {
            println!("cargo:warning=No Lumina installer found: build Lumina first (npm run tauri build) or set LUMINA_INSTALLER");
            fs::write(&out, b"").unwrap();
            println!("cargo:rustc-env=LUMINA_PAYLOAD_NAME=");
        }
    }
    tauri_build::build()
}

// Lumina's engine, without any window: the desktop app and the server are both built on it.
// Modules move here from the desktop crate in slices (Lumina 5.0, phase 0); each one reaches the rest of the
// engine through a `Host` (data folder, events) instead of Tauri.
use base64::{engine::general_purpose, Engine as _};
use exif::{Reader, Tag, Value};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use reverse_geocoder::ReverseGeocoder;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use walkdir::WalkDir;

pub mod ai;
pub mod albums;
pub mod backup;
pub mod clip;
pub mod db;
pub mod decode;
pub mod duplicates;
pub mod exif_meta;
pub mod export;
pub mod face_engine;
pub mod face_match;
pub mod face_ort;
pub mod face_quality;
pub mod face_review;
pub mod face_scan;
pub mod fastdecode;
pub mod ffmpeg;
pub mod files;
pub mod gallery;
pub mod highlights;
pub mod host;
pub mod imaging;
pub mod import;
pub mod libraries;
pub mod library;
pub mod people;
pub mod photo_meta;
pub mod perf;
pub mod recycle;
pub mod scan;
pub mod search;
pub mod storage;
pub mod thumbs;
pub mod types;
pub mod video_frames;
pub mod video_meta;
pub mod watch;

use db::*;
use decode::*;
use exif_meta::*;
use face_engine::*;
use fastdecode::*;
use face_ort::*;
use scan::*;
use storage::*;
use thumbs::*;
use host::*;
use imaging::*;
use perf::*;
use types::*;
use library::*;
use face_match::*;
use rayon::prelude::*;

#[cfg(test)]
mod face_eval;
#[cfg(test)]
mod tests;

// Offline place names for coordinates (loaded once, on first use)
pub static GEOCODER: LazyLock<ReverseGeocoder> = LazyLock::new(ReverseGeocoder::new);

// Shared HTTP clients (Ollama, model downloads): one connection pool each
pub static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default()
});

// For quick "is Ollama there?" checks that must not hold up the UI
pub static FAST_STATUS_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1200))
        .build()
        .unwrap_or_default()
});

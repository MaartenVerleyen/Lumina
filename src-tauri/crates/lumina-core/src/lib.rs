// Lumina's engine, without any window: the desktop app and the server are both built on it.
// Modules move here from the desktop crate in slices (Lumina 5.0, phase 0); each one reaches the rest of the
// engine through a `Host` (data folder, events) instead of Tauri.
use exif::{Reader, Tag, Value};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use reverse_geocoder::ReverseGeocoder;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use walkdir::WalkDir;

pub mod clip;
pub mod db;
pub mod decode;
pub mod exif_meta;
pub mod face_engine;
pub mod face_ort;
pub mod face_match;
pub mod fastdecode;
pub mod ffmpeg;
pub mod host;
pub mod imaging;
pub mod perf;
pub mod recycle;
pub mod scan;
pub mod storage;
pub mod thumbs;
pub mod types;
pub mod video_frames;
pub mod video_meta;

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
use rayon::prelude::*;

// Offline place names for coordinates (loaded once, on first use)
pub static GEOCODER: LazyLock<ReverseGeocoder> = LazyLock::new(ReverseGeocoder::new);

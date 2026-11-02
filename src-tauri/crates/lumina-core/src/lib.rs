// Lumina's engine, without any window: the desktop app and the server are both built on it.
// Modules move here from the desktop crate in slices (Lumina 5.0, phase 0); each one reaches the rest of the
// engine through a `Host` (data folder, events) instead of Tauri.
use exif::{Reader, Tag, Value};
use image::{imageops::FilterType, DynamicImage, GenericImageView};
use reverse_geocoder::ReverseGeocoder;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

pub mod db;
pub mod exif_meta;
pub mod host;
pub mod imaging;
pub mod perf;
pub mod storage;
pub mod video_meta;

use exif_meta::*;
use host::*;

// Offline place names for coordinates (loaded once, on first use)
pub static GEOCODER: LazyLock<ReverseGeocoder> = LazyLock::new(ReverseGeocoder::new);

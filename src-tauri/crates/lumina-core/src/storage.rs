use crate::*;

// ----------------- DRIVE-AWARE I/O PARALLELISM -----------------

#[cfg(windows)]
fn drive_letter(path: &Path) -> Option<char> {
    match path.components().next()? {
        std::path::Component::Prefix(prefix) => match prefix.kind() {
            std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                Some((letter as char).to_ascii_uppercase())
            }
            _ => None,
        },
        _ => None,
    }
}

// true = spinning hard drive (seeks are expensive), false = SSD, None = unknown (network share, error)
#[cfg(windows)]
pub fn drive_has_seek_penalty(path: &Path) -> Option<bool> {
    use std::ffi::c_void;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceSeekPenaltyProperty, DEVICE_SEEK_PENALTY_DESCRIPTOR,
        IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_PROPERTY_QUERY,
    };
    use windows::Win32::System::IO::DeviceIoControl;

    let letter = drive_letter(path)?;
    let volume = HSTRING::from(format!(r"\\.\{letter}:"));
    // Access 0 = query metadata only; works without administrator rights
    let handle = unsafe {
        CreateFileW(
            &volume,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .ok()?;

    let query = STORAGE_PROPERTY_QUERY {
        PropertyId: StorageDeviceSeekPenaltyProperty,
        QueryType: PropertyStandardQuery,
        ..Default::default()
    };
    let mut descriptor = DEVICE_SEEK_PENALTY_DESCRIPTOR::default();
    let mut returned = 0u32;
    let result = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            Some(&query as *const _ as *const c_void),
            std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            Some(&mut descriptor as *mut _ as *mut c_void),
            std::mem::size_of::<DEVICE_SEEK_PENALTY_DESCRIPTOR>() as u32,
            Some(&mut returned),
            None,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.ok()?;
    Some(descriptor.IncursSeekPenalty)
}

// Linux says per block device whether it spins (/sys/block/<disk>/queue/rotational, also behind a USB
// bridge). The folder's device number leads to it; a partition's own entry has no queue, its disk's has.
// Btrfs gives each subvolume a device number of its own (0:54) with no such entry: then the device the
// folder's mount comes from (/proc/self/mountinfo). Network shares and containers without /sys: unknown.
#[cfg(target_os = "linux")]
pub fn drive_has_seek_penalty(path: &Path) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    let dev = fs::metadata(path).ok()?.dev();
    let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff);
    let minor = (dev & 0xff) | ((dev >> 12) & !0xff);
    let device = fs::canonicalize(format!("/sys/dev/block/{major}:{minor}"))
        .ok()
        .filter(|d| d.starts_with("/sys/devices"))
        .or_else(|| mounted_from(path))?;
    rotational_in(&device).or_else(|| device.parent().and_then(rotational_in))
}

// The block device (its /sys entry) of the mount a folder is on: the longest mount point it sits under
#[cfg(target_os = "linux")]
fn mounted_from(path: &Path) -> Option<PathBuf> {
    let path = fs::canonicalize(path).ok()?;
    let mounts = fs::read_to_string("/proc/self/mountinfo").ok()?;
    let mut best: Option<(usize, String)> = None;
    for line in mounts.lines() {
        // "36 35 0:54 /@home /home rw,... shared:1 - btrfs /dev/nvme0n1p2 rw,..."
        let Some((left, right)) = line.split_once(" - ") else { continue };
        let (Some(point), Some(source)) = (left.split(' ').nth(4), right.split(' ').nth(1)) else { continue };
        let point = point.replace("\\040", " ");
        if source.starts_with("/dev/") && path.starts_with(&point) && best.as_ref().is_none_or(|(len, _)| point.len() > *len) {
            best = Some((point.len(), source.to_string()));
        }
    }
    let source = fs::canonicalize(best?.1).ok()?;
    fs::canonicalize(Path::new("/sys/class/block").join(source.file_name()?)).ok()
}

#[cfg(target_os = "linux")]
fn rotational_in(dir: &Path) -> Option<bool> {
    match fs::read_to_string(dir.join("queue").join("rotational")).ok()?.trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn drive_has_seek_penalty(_path: &Path) -> Option<bool> {
    None
}

// Threads for the file-reading index pass. On a hard drive many parallel readers make the head jump
// between files (baseline: 52 files/s on 12 threads); a couple of readers keep reads close together.
// LUMINA_INDEX_THREADS overrides this for benchmarking.
pub fn index_io_threads(root: &Path) -> (usize, String) {
    if let Some(n) = std::env::var("LUMINA_INDEX_THREADS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return (n.max(1), "override".to_string());
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
    match drive_has_seek_penalty(root) {
        Some(true) => (2, "HDD".to_string()),
        Some(false) => (cores, "SSD".to_string()),
        None => (4.min(cores), "unknown drive".to_string()),
    }
}

// Background work yields to the UI/WebView threads under load (the OS still gives it all idle CPU)
pub fn lower_current_thread_priority() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

// One shared pool for heavy background image work (thumbnails, face scans). Separate per-job pools used to
// add up (two jobs = 2 x 12 threads on 16 cores); sharing caps the total at 3/4 of the cores.
pub static BG_POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(|| {
    let threads = std::thread::available_parallelism()
        .map(|n| (n.get() * 3) / 4)
        .unwrap_or(6)
        .max(2);
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("lumina-bg-{i}"))
        .start_handler(|_| lower_current_thread_priority())
        .build()
        .expect("failed to start the background thread pool")
});



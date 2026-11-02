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

#[cfg(not(windows))]
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



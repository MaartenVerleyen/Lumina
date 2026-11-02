// Sending files to the Windows Recycle Bin without ever deleting one permanently by surprise.
//
// The shell silently deletes a file for good when the Recycle Bin can't take it (too big for the bin's
// size limit, a network or removable drive, or "Don't move files to the Recycle Bin" switched on).
// The `trash` crate runs the shell with all UI suppressed, so that happened without a word. Here the
// shell reports every item to a progress sink first, and the sink refuses any delete that wouldn't
// land in the Recycle Bin. A refused item stays where it was.

use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct RecycleBinInfo {
    // Drive root, e.g. "D:\"
    pub drive: String,
    // Size limit of the Recycle Bin on that drive in bytes (None: Windows didn't say, e.g. never configured)
    pub capacity: Option<u64>,
    // Bytes already in the Recycle Bin on that drive
    pub used: u64,
    // False for drives without a Recycle Bin (network, removable) or when it is switched off
    pub supported: bool,
}

pub struct RecycleOutcome {
    // Paths that are gone afterwards
    pub gone: Vec<PathBuf>,
    // Paths that are still there, with the reason
    pub failed: Vec<(PathBuf, String)>,
    // True when the shell wanted to delete something permanently and Lumina refused
    pub refused_permanent: bool,
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows::core::{implement, Ref, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{E_ABORT, RPC_E_CHANGED_MODE};
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeNameForVolumeMountPointW, GetVolumePathNameW};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
        SHCreateItemFromParsingName, SHQueryRecycleBinW, FOF_ALLOWUNDO, FOF_NO_UI, FOF_WANTNUKEWARNING,
        SHQUERYRBINFO, TSF_DELETE_RECYCLE_IF_POSSIBLE,
    };

    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_REMOTE: u32 = 4;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    // Keeps COM initialised for the lifetime of the guard on this thread
    struct Com(bool);
    impl Com {
        fn init() -> Com {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            // Already initialised in another mode on this thread: usable as is, but not ours to undo
            Com(hr.is_ok() && hr != RPC_E_CHANGED_MODE)
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    pub fn bin_info(path: &Path) -> RecycleBinInfo {
        let mut root = [0u16; 261];
        let p = wide(path.as_os_str());
        if unsafe { GetVolumePathNameW(PCWSTR(p.as_ptr()), &mut root) }.is_err() {
            return RecycleBinInfo::default();
        }
        let drive = from_wide(&root);
        let root_w = wide(std::ffi::OsStr::new(&drive));
        let drive_type = unsafe { GetDriveTypeW(PCWSTR(root_w.as_ptr())) };

        let mut used = 0u64;
        let mut q = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
        if unsafe { SHQueryRecycleBinW(PCWSTR(root_w.as_ptr()), &mut q) }.is_ok() {
            used = q.i64Size.max(0) as u64;
        }

        // Per-volume settings live under BitBucket\Volume\{GUID}: MaxCapacity (MB) and NukeOnDelete
        let mut volume = [0u16; 64];
        let mut capacity = None;
        let mut nuke = false;
        if unsafe { GetVolumeNameForVolumeMountPointW(PCWSTR(root_w.as_ptr()), &mut volume) }.is_ok() {
            let name = from_wide(&volume);
            if let (Some(a), Some(b)) = (name.find('{'), name.find('}')) {
                let key = format!(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\{}",
                    &name[a..=b]
                );
                let read = |value: &str| -> Option<u32> {
                    let (k, v) = (wide(key.as_ref()), wide(value.as_ref()));
                    let mut data = 0u32;
                    let mut size = 4u32;
                    let err = unsafe {
                        RegGetValueW(
                            HKEY_CURRENT_USER,
                            PCWSTR(k.as_ptr()),
                            PCWSTR(v.as_ptr()),
                            RRF_RT_REG_DWORD,
                            None,
                            Some(&mut data as *mut u32 as *mut _),
                            Some(&mut size),
                        )
                    };
                    err.is_ok().then_some(data)
                };
                capacity = read("MaxCapacity").map(|mb| mb as u64 * 1024 * 1024);
                nuke = read("NukeOnDelete").unwrap_or(0) != 0;
            }
        }

        RecycleBinInfo {
            drive,
            capacity,
            used,
            supported: !nuke && drive_type != DRIVE_REMOTE && drive_type != DRIVE_REMOVABLE,
        }
    }

    // Refuses any delete the shell would do permanently. Refusing stops the rest of the batch too.
    #[implement(IFileOperationProgressSink)]
    struct RecycleOnly {
        refused: Arc<AtomicBool>,
    }

    impl IFileOperationProgressSink_Impl for RecycleOnly_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreDeleteItem(&self, flags: u32, _: Ref<IShellItem>) -> windows::core::Result<()> {
            if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
                self.refused.store(true, Ordering::Release);
                return Err(E_ABORT.into());
            }
            Ok(())
        }
        fn PostDeleteItem(&self, _: u32, _: Ref<IShellItem>, hr: HRESULT, recycled: Ref<IShellItem>) -> windows::core::Result<()> {
            // Belt and braces: a successful delete with no Recycle Bin item was permanent after all
            if hr.is_ok() && recycled.is_none() {
                self.refused.store(true, Ordering::Release);
            }
            Ok(())
        }
        fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: &PCWSTR, _: u32, _: HRESULT, _: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    pub fn recycle(paths: &[PathBuf]) -> RecycleOutcome {
        let _com = Com::init();
        let refused = Arc::new(AtomicBool::new(false));
        let mut failed: Vec<(PathBuf, String)> = Vec::new();

        let run = || -> windows::core::Result<()> {
            unsafe {
                let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
                op.SetOperationFlags(FOF_NO_UI | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING)?;
                let sink: IFileOperationProgressSink = RecycleOnly { refused: refused.clone() }.into();
                op.Advise(&sink)?;
                let mut queued = 0;
                for p in paths {
                    if !p.exists() {
                        continue;
                    }
                    let name = wide(p.as_os_str());
                    let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None)?;
                    op.DeleteItem(&item, None)?;
                    queued += 1;
                }
                if queued > 0 {
                    // An aborted item makes this return an error; what happened is checked on disk below
                    let _ = op.PerformOperations();
                }
                Ok(())
            }
        };
        let run_error = run().err().map(|e| e.message());

        let refused_permanent = refused.load(Ordering::Acquire);
        let mut gone = Vec::new();
        for p in paths {
            if !p.exists() {
                gone.push(p.clone());
            } else {
                let why = if refused_permanent {
                    "the Recycle Bin can't take it (Windows would have deleted it permanently)".to_string()
                } else {
                    format!("could not move to Recycle Bin{}", run_error.as_ref().map(|e| format!(": {e}")).unwrap_or_default())
                };
                failed.push((p.clone(), why));
            }
        }
        RecycleOutcome { gone, failed, refused_permanent }
    }
}

pub fn bin_info(path: &Path) -> RecycleBinInfo {
    #[cfg(windows)]
    {
        win::bin_info(path)
    }
    // Other systems (the Linux server): no Recycle Bin anyone would look in. Emptying _Trash is then a
    // permanent delete the user is asked about first.
    #[cfg(not(windows))]
    {
        RecycleBinInfo { drive: path.to_string_lossy().into_owned(), supported: false, ..Default::default() }
    }
}

// Moves the files to the Recycle Bin in one shell operation. Never deletes anything permanently.
pub fn recycle(paths: &[PathBuf]) -> RecycleOutcome {
    #[cfg(windows)]
    {
        win::recycle(paths)
    }
    #[cfg(not(windows))]
    {
        let failed = paths.iter().map(|p| (p.clone(), "this system has no Recycle Bin".to_string())).collect();
        RecycleOutcome { gone: Vec::new(), failed, refused_permanent: true }
    }
}

use std::fs;
use std::path::PathBuf;

/// Absolute path to the app's data directory (`~/Library/Application
/// Support/com.kindling.desktop` on macOS), creating it if it doesn't exist.
#[tauri::command]
pub fn app_data_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let dir: PathBuf = home
        .join("Library")
        .join("Application Support")
        .join("com.kindling.desktop");

    fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create app data dir at {}: {e}", dir.display()))?;

    // Owner-only (0700): config.json holds the SMTP app password and the ledger
    // holds browsing history — other local accounts must not be able to read them.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }

    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "app data dir path is not valid UTF-8".to_string())
}

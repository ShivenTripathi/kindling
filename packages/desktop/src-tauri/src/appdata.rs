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

    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "app data dir path is not valid UTF-8".to_string())
}

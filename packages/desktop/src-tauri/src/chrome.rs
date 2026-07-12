use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
}

/// Root of the Chrome user-data directory. Honors `KINDLING_CHROME_ROOT` for
/// tests/overrides, otherwise defaults to the macOS Chrome location.
fn chrome_root() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("KINDLING_CHROME_ROOT") {
        return Ok(PathBuf::from(dir));
    }
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("Application Support")
        .join("Google")
        .join("Chrome"))
}

#[tauri::command]
pub fn list_chrome_profiles() -> Result<Vec<Profile>, String> {
    let root = chrome_root()?;
    let local_state_path = root.join("Local State");
    let contents = fs::read_to_string(&local_state_path).map_err(|e| {
        format!(
            "could not read Chrome Local State at {}: {e}",
            local_state_path.display()
        )
    })?;
    let json: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("could not parse Chrome Local State JSON: {e}"))?;

    let info_cache = json
        .get("profile")
        .and_then(|p| p.get("info_cache"))
        .and_then(|c| c.as_object())
        .ok_or_else(|| "Local State missing profile.info_cache".to_string())?;

    let mut profiles: Vec<Profile> = info_cache
        .iter()
        .map(|(id, info)| {
            let name = info
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(id)
                .to_string();
            let email = info
                .get("user_name")
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            Profile {
                id: id.clone(),
                name,
                email,
            }
        })
        .collect();

    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(profiles)
}

#[tauri::command]
pub fn newest_session_bytes(profile_id: String) -> Result<Vec<u8>, String> {
    let root = chrome_root()?;
    let sessions_dir = root.join(&profile_id).join("Sessions");

    let entries = fs::read_dir(&sessions_dir).map_err(|e| {
        format!(
            "could not read Sessions directory at {}: {e}",
            sessions_dir.display()
        )
    })?;

    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in entries {
        let entry = entry.map_err(|e| format!("error reading Sessions directory entry: {e}"))?;
        let path = entry.path();
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !file_name.starts_with("Session_") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|e| format!("could not stat {}: {e}", path.display()))?;
        let modified = metadata
            .modified()
            .map_err(|e| format!("could not read mtime for {}: {e}", path.display()))?;
        match &newest {
            Some((_, best_mtime)) if *best_mtime >= modified => {}
            _ => newest = Some((path, modified)),
        }
    }

    let (newest_path, _) = newest.ok_or_else(|| {
        format!(
            "no Session_* files found in {}",
            sessions_dir.display()
        )
    })?;

    fs::read(&newest_path).map_err(|e| format!("could not read {}: {e}", newest_path.display()))
}

mod appdata;
mod chrome;
mod smtp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      chrome::list_chrome_profiles,
      chrome::newest_session_bytes,
      smtp::send_smtp,
      appdata::app_data_dir,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

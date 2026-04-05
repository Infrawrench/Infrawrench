mod keychain;
mod encryption;
mod pg;
mod mysql;

use base64::{Engine as _, engine::general_purpose};
use tauri::Manager;
use std::sync::Mutex;

pub struct AppState {
    pub encryption_key: Mutex<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_or_create_encryption_key,
            encrypt_value,
            decrypt_value,
            pg::pg_query,
            pg::pg_execute,
            mysql::mysql_query,
            mysql::mysql_execute,
        ])
        .setup(|app| {
            // Load or generate the master key from the app data directory.
            // This is reliable across restarts and doesn't depend on OS keychain signing.
            let data_dir = app.path().app_data_dir()?;
            let key_path = data_dir.join("master.key");
            let key = keychain::load_or_create_key(&key_path)
                .expect("Failed to load or create encryption key");
            app.manage(AppState { encryption_key: Mutex::new(key) });

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Expose the key to the frontend (base64) — only used for debugging; remove in prod.
#[tauri::command]
async fn get_or_create_encryption_key(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state.encryption_key.lock().unwrap().clone())
}

/// Encrypt a plaintext string using AES-256-GCM.
/// Returns `{ ciphertext: base64, iv: base64 }`.
#[tauri::command]
async fn encrypt_value(
    state: tauri::State<'_, AppState>,
    plaintext: String,
) -> Result<serde_json::Value, String> {
    let key_b64 = state.encryption_key.lock().unwrap().clone();
    let key_bytes = general_purpose::STANDARD.decode(&key_b64).map_err(|e| e.to_string())?;
    let (ciphertext, iv) = encryption::encrypt(&plaintext, &key_bytes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ciphertext": ciphertext, "iv": iv }))
}

/// Decrypt a base64-encoded ciphertext with the given IV.
#[tauri::command]
async fn decrypt_value(
    state: tauri::State<'_, AppState>,
    ciphertext: String,
    iv: String,
) -> Result<String, String> {
    let key_b64 = state.encryption_key.lock().unwrap().clone();
    let key_bytes = general_purpose::STANDARD.decode(&key_b64).map_err(|e| e.to_string())?;
    encryption::decrypt(&ciphertext, &iv, &key_bytes).map_err(|e| e.to_string())
}

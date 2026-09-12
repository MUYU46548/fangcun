#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    backend_url: Mutex<String>,
}

fn main() {
    let backend_port = 8753;
    let backend_url = format!("http://127.0.0.1:{}", backend_port);

    tauri::Builder::default()
        .manage(AppState {
            backend_url: Mutex::new(backend_url.clone()),
        })
        .setup(move |app| {
            // Find Python executable
            let python_exe = find_python().unwrap_or_else(|| {
                eprintln!("Python not found in PATH. Please install Python 3.10+");
                std::process::exit(1);
            });

            println!("Using Python: {}", python_exe);

            // Get the path to tegula.py (relative to the Tauri app)
            let app_dir = app.path().app_data_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
            let tegula_path = app_dir.join("tegula.py");

            // If tegula.py doesn't exist in app_data_dir, copy it from resources
            if !tegula_path.exists() {
                // In production, embed tegula.py as a resource
                // For now, assume it's in the same directory as the exe
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_default();
                let resource_tegula = exe_dir.join("tegula.py");
                if resource_tegula.exists() {
                    let _ = std::fs::copy(&resource_tegula, &tegula_path);
                }
            }

            // Start Python backend
            let mut child = Command::new(&python_exe)
                .arg(&tegula_path)
                .arg("serve")
                .arg("--port")
                .arg(backend_port.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start Python backend: {}", e))?;

            // Log stdout/stderr
            if let Some(stdout) = child.stdout.take() {
                tauri::async_runtime::spawn(async move {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            println!("[py-backend] {}", line);
                        }
                    }
                });
            }
            if let Some(stderr) = child.stderr.take() {
                tauri::async_runtime::spawn(async move {
                    use std::io::{BufRead, BufReader};
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            eprintln!("[py-backend:err] {}", line);
                        }
                    }
                });
            }

            // Wait for backend to be ready
            println!("Waiting for Python backend at {}...", backend_url);
            let client = reqwest::blocking::Client::new();
            let health_url = format!("{}/ping", backend_url);

            for i in 0..60 {
                if i > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                match client.get(&health_url).send() {
                    Ok(resp) if resp.status().is_success() => {
                        println!("Python backend is ready!");
                        break
                    }
                    _ => {
                        if i == 59 {
                            eprintln!("Warning: Python backend did not respond, opening anyway...");
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_backend_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn get_backend_url(state: State<'_, AppState>) -> String {
    state.backend_url.lock().unwrap().clone()
}

fn find_python() -> Option<String> {
    // Try various Python executable names
    for name in &["python3", "python", "py"] {
        if let Ok(output) = Command::new(name).arg("--version").output() {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout);
                println!("Found {}: {}", name, version_str.trim());
                return Some(name.to_string());
            }
        }
    }
    None
}

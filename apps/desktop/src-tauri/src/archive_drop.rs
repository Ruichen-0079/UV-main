//! File transport only. Validation and installation remain in the Runtime importer.
use std::{fs::File, io::Read, path::PathBuf, sync::Mutex};
use tauri::{Manager, Window, WindowEvent};

#[derive(Default)]
pub struct ArchiveDrop(Mutex<Vec<PathBuf>>);

pub fn record(window: &Window, event: &WindowEvent) {
  if window.label() != "webui" {
    return;
  }
  if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
    if let Ok(mut allowed) = window.state::<ArchiveDrop>().0.lock() {
      *allowed = paths.clone();
    }
  }
}

#[tauri::command]
pub async fn read_dropped_archive(
  window: Window,
  path: PathBuf,
) -> Result<tauri::ipc::Response, String> {
  if window.label() != "webui" {
    return Err("Archive drops require WebUI.".into());
  }
  {
    let state = window.state::<ArchiveDrop>();
    let mut allowed = state.0.lock().map_err(|e| e.to_string())?;
    if !allowed.contains(&path) {
      return Err("Choose or drop the ZIP again.".into());
    }
    allowed.clear();
  }
  tauri::async_runtime::spawn_blocking(move || read_archive(path).map(tauri::ipc::Response::new))
    .await
    .map_err(|e| e.to_string())?
}

fn read_archive(path: PathBuf) -> Result<Vec<u8>, String> {
  const LIMIT: u64 = 64 * 1024 * 1024;
  if !path
    .extension()
    .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
  {
    return Err("Choose a file ending in .zip.".into());
  }
  let file = File::open(path).map_err(|e| e.to_string())?;
  let metadata = file.metadata().map_err(|e| e.to_string())?;
  if !metadata.is_file() {
    return Err("Drop a ZIP file, not a directory.".into());
  }
  if metadata.len() > LIMIT {
    return Err("Choose a Live2D ZIP under 64 MiB.".into());
  }
  let mut bytes = Vec::new();
  file
    .take(LIMIT + 1)
    .read_to_end(&mut bytes)
    .map_err(|e| e.to_string())?;
  if bytes.len() as u64 > LIMIT {
    return Err("Choose a Live2D ZIP under 64 MiB.".into());
  }
  Ok(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn transports_bytes_without_installing_or_parsing_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Lumi.ZIP");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    assert_eq!(read_archive(path).unwrap(), vec![1, 2, 3]);
  }
  #[test]
  fn rejects_directories_and_oversized_transport() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("folder.zip");
    std::fs::create_dir(&folder).unwrap();
    assert!(read_archive(folder).is_err());
    let path = dir.path().join("large.zip");
    File::create(&path)
      .unwrap()
      .set_len(64 * 1024 * 1024 + 1)
      .unwrap();
    assert!(read_archive(path).unwrap_err().contains("64 MiB"));
    assert!(read_archive(dir.path().join("model.txt"))
      .unwrap_err()
      .contains(".zip"));
  }
}

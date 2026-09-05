//! Spawns and proxies the Node desktop supervisor for development mode.
//! Control-token never leaves Rust into the React surface.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct SupervisorState {
  inner: Mutex<SupervisorInner>,
}

#[derive(Default)]
struct SupervisorInner {
  child: Option<Child>,
  base_url: Option<String>,
  control_token: Option<String>,
  instance_id: Option<String>,
  expected_pid: Option<u32>,
  repo_root: Option<PathBuf>,
  state_dir: Option<PathBuf>,
  poll_stop: bool,
  shutting_down: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndpointFile {
  host: String,
  port: u16,
  base_url: String,
  instance_id: String,
  pid: u32,
  started_at: String,
  control_token: String,
}

#[tauri::command]
pub fn get_service_status(state: State<'_, SupervisorState>) -> Result<Value, String> {
  let (base, token) = require_endpoint(&state)?;
  http_json("GET", &format!("{base}/v1/status"), None, Some(&token))
}

#[tauri::command]
pub fn refresh_services(state: State<'_, SupervisorState>) -> Result<Value, String> {
  let (base, token) = require_endpoint(&state)?;
  http_json("POST", &format!("{base}/v1/refresh"), None, Some(&token))
}

#[tauri::command]
pub fn service_action(
  state: State<'_, SupervisorState>,
  action: String,
  service_id: String,
) -> Result<Value, String> {
  let (base, token) = require_endpoint(&state)?;
  let path = match action.as_str() {
    "restart" | "stop" | "start" => format!("{base}/v1/services/{service_id}/{action}"),
    _ => return Err(format!("unsupported action: {action}")),
  };
  http_json("POST", &path, None, Some(&token))
}

/// Push latest user env overrides (incl. secrets + unsets) to a live Supervisor.
/// Body is POSTed over loopback with control token — never via argv or disk files.
pub fn push_runtime_config(
  app: &AppHandle,
  payload: &crate::config::env_export::SupervisorConfigPush,
) -> Result<Value, String> {
  let state = app.state::<SupervisorState>();
  let (base, token) = require_endpoint(&state)?;
  let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;
  // Never log `body` — may contain secrets.
  http_json(
    "POST",
    &format!("{base}/v1/config"),
    Some(&body),
    Some(&token),
  )
}

pub fn bootstrap_supervisor(
  app: &AppHandle,
  env_overrides: Option<std::collections::BTreeMap<String, String>>,
) -> Result<(), String> {
  use crate::packaging::{
    assert_no_secret_in_args, desktop_state_dir, discover_repo_root,
    resolve_development_launch, resolve_launch_mode, resolve_packaged_launch,
    SupervisorLaunchMode, SupervisorLaunchPlan,
  };

  let root_state_dir = desktop_state_dir();
  fs::create_dir_all(&root_state_dir).map_err(|e| e.to_string())?;
  let active_pointer = root_state_dir.join("active-instance.json");

  let mode = resolve_launch_mode();
  if matches!(mode, SupervisorLaunchMode::Packaged) {
    if let Some(cfg) = app.try_state::<crate::config::ConfigState>() {
      cfg.service
        .ensure_private_postgres_password()
        .map_err(|error| format!("private PostgreSQL secret persist failed: {error}"))?;
    }
  }
  let plan = match mode {
    SupervisorLaunchMode::Development => {
      let repo_root = discover_repo_root()?;
      SupervisorLaunchPlan::Development(resolve_development_launch(repo_root)?)
    }
    SupervisorLaunchMode::Packaged => {
      let resource_root = resolve_packaged_resource_root(app)?;
      let plan = resolve_packaged_launch(resource_root, root_state_dir.clone()).map_err(|e| {
        // Never fall back to pnpm/tsx in packaged/release mode.
        format!("packaging error: {e}")
      })?;
      SupervisorLaunchPlan::Packaged(plan)
    }
  };

  let (mut command, cwd, repo_root_for_state) = match &plan {
    SupervisorLaunchPlan::Development(dev) => {
      let command = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd.exe");
        cmd.args([
          "/d",
          "/c",
          "pnpm",
          "exec",
          "tsx",
          dev.supervisor_script.to_string_lossy().as_ref(),
          "--repo-root",
          dev.repo_root.to_string_lossy().as_ref(),
          "--state-directory",
          root_state_dir.to_string_lossy().as_ref(),
        ]);
        cmd
      } else if {
        let local_tsx = dev.repo_root.join("node_modules").join(".bin").join("tsx");
        local_tsx.is_file()
      } {
        // Prefer the repo-local runtime on Linux/macOS. This keeps desktop
        // development independent of pnpm's install/build policy and makes
        // the already-installed workspace dependencies usable as-is.
        let local_tsx = dev.repo_root.join("node_modules").join(".bin").join("tsx");
        let mut cmd = Command::new(local_tsx);
        cmd.args([
          "--conditions",
          "development",
          dev.supervisor_script.to_string_lossy().as_ref(),
          "--repo-root",
        ])
        .arg(&dev.repo_root)
        .arg("--state-directory")
        .arg(&root_state_dir);
        cmd
      } else if let Some(pnpm) = which_command("pnpm") {
        let mut cmd = Command::new(pnpm);
        cmd.args([
          "exec",
          "tsx",
          dev.supervisor_script.to_string_lossy().as_ref(),
          "--repo-root",
        ])
        .arg(&dev.repo_root)
        .arg("--state-directory")
        .arg(&root_state_dir);
        cmd
      } else {
        let node = which_command("node")
          .ok_or_else(|| "node/pnpm is required for desktop supervisor".to_string())?;
        let mut cmd = Command::new(node);
        cmd.arg("--import")
          .arg("tsx")
          .arg(&dev.supervisor_script)
          .arg("--repo-root")
          .arg(&dev.repo_root)
          .arg("--state-directory")
          .arg(&root_state_dir);
        cmd
      };
      (command, dev.repo_root.clone(), Some(dev.repo_root.clone()))
    }
    SupervisorLaunchPlan::Packaged(pkg) => {
      use crate::packaging::{select_packaged_supervisor_command, PackagedSupervisorCommand};
      let selected = select_packaged_supervisor_command(pkg);
      let command = match &selected {
        PackagedSupervisorCommand::Exe { file, args } => {
          assert_no_secret_in_args(args)?;
          let mut cmd = Command::new(file);
          cmd.args(args);
          cmd
        }
        PackagedSupervisorCommand::NodeCjs { node, cjs, args } => {
          assert_no_secret_in_args(args)?;
          // Bundled node only — never PATH node.
          let mut cmd = Command::new(node);
          cmd.arg(cjs);
          cmd.args(args);
          cmd
        }
      };
      // cwd is LocalAppData state root — never the install directory.
      (command, pkg.state_root.clone(), None)
    }
  };

  // Inject non-secret public overrides only. Credential secrets are applied
  // after the control plane is up via POST /v1/config so they stay in the
  // dynamic override layer and can be cleared without poisoning baseEnv.
  if let Some(overrides) = env_overrides {
    for (key, value) in overrides {
      if value.trim().is_empty() {
        continue;
      }
      if is_secret_env_key(&key) {
        continue;
      }
      command.env(key, value);
    }
  }
  command
    .current_dir(&cwd)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }

  let child = command
    .spawn()
    .map_err(|e| format!("failed to spawn supervisor: {e}"))?;

  let endpoint = wait_for_active_endpoint(&active_pointer, Duration::from_secs(25))?;
  // Validate endpoint PID is alive and host is loopback.
  if endpoint.host != "127.0.0.1" && endpoint.host != "localhost" && endpoint.host != "::1" {
    return Err("supervisor endpoint host is not loopback".to_string());
  }
  if !process_alive(endpoint.pid) {
    return Err("supervisor endpoint pid is not running (stale)".to_string());
  }
  if endpoint.control_token.len() < 32 {
    return Err("supervisor endpoint missing control token".to_string());
  }

  let instance_state_dir = root_state_dir.join(&endpoint.instance_id);

  {
    let state = app.state::<SupervisorState>();
    let mut guard = state
      .inner
      .lock()
      .map_err(|_| "supervisor lock poisoned".to_string())?;
    guard.child = Some(child);
    guard.base_url = Some(endpoint.base_url.clone());
    guard.control_token = Some(endpoint.control_token.clone());
    guard.instance_id = Some(endpoint.instance_id.clone());
    guard.expected_pid = Some(endpoint.pid);
    guard.repo_root = repo_root_for_state;
    guard.state_dir = Some(instance_state_dir);
    guard.poll_stop = false;
    guard.shutting_down = false;
  }

  // Apply full user config (incl. secrets + unsets) as dynamic overrides, then
  // wait for the Supervisor's bootstrap/reconcile contract before returning.
  // This is an explicit ACK barrier, not a timing delay or retry.
  let token = endpoint.control_token.clone();
  let base_url = endpoint.base_url.clone();
  let config_body = app
    .try_state::<crate::config::ConfigState>()
    .and_then(|cfg| cfg.service.supervisor_config_push().ok())
    .and_then(|payload| serde_json::to_string(&payload).ok());
  if let Some(body) = config_body {
    // Never log body — may contain secrets.
    http_json(
      "POST",
      &format!("{base_url}/v1/config"),
      Some(&body),
      Some(&token),
    )
    .map_err(|error| format!("supervisor config barrier failed: {error}"))?;
  }
  http_json(
    "POST",
    &format!("{base_url}/v1/bootstrap"),
    None,
    Some(&token),
  )
  .map_err(|error| format!("supervisor bootstrap barrier failed: {error}"))?;

  // Publish a non-secret readiness marker only after both ACKs above. The
  // Tauri smoke uses this marker as the bootstrap barrier; the Supervisor's
  // active-instance pointer intentionally remains available earlier so the
  // control plane can be reached during startup.
  let ready_marker = root_state_dir.join("tauri-bootstrap-ready.json");
  let ready_payload = serde_json::json!({
    "schemaVersion": 1,
    "instanceId": endpoint.instance_id,
    "supervisorPid": endpoint.pid,
    "tauriPid": std::process::id(),
    "readyAtMs": std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|duration| duration.as_millis())
      .unwrap_or_default()
  });
  fs::write(
    &ready_marker,
    serde_json::to_vec(&ready_payload).map_err(|error| error.to_string())?,
  )
  .map_err(|error| format!("tauri bootstrap readiness marker failed: {error}"))?;

  start_status_poller(app.clone());
  Ok(())
}

fn is_secret_env_key(key: &str) -> bool {
  matches!(
    key,
    "DEEPSEEK_API_KEY"
      | "OPENAI_COMPATIBLE_API_KEY"
      | "DATABASE_URL"
      | "YUVI_POSTGRES_PASSWORD"
      | "PGPASSWORD"
  )
}

#[cfg(test)]
mod tests {
  use super::{is_secret_env_key, stop_child_bounded};
  use std::process::{Command, Stdio};
  use std::time::{Duration, Instant};

  #[test]
  fn openai_compatible_api_key_stays_out_of_supervisor_base_environment() {
    assert!(is_secret_env_key("OPENAI_COMPATIBLE_API_KEY"));
  }

  #[test]
  fn supervisor_child_shutdown_reaps_without_an_unbounded_wait() {
    let mut command = if cfg!(target_os = "windows") {
      let mut command = Command::new("cmd.exe");
      command.args(["/d", "/c", "ping 127.0.0.1 -n 30 > nul"]);
      command
    } else {
      let mut command = Command::new("sleep");
      command.arg("30");
      command
    };
    let child = command
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("test child should spawn");
    let started = Instant::now();

    assert!(stop_child_bounded(child));
    assert!(started.elapsed() < Duration::from_secs(5));
  }
}

/// Idempotent application-level shutdown. Only owned services are stopped by the supervisor.
pub fn shutdown_supervisor(app: &AppHandle) {
  let state = app.state::<SupervisorState>();
  let mut guard = match state.inner.lock() {
    Ok(g) => g,
    Err(_) => return,
  };
  if guard.shutting_down {
    return;
  }
  guard.shutting_down = true;
  guard.poll_stop = true;
  let base = guard.base_url.clone();
  let token = guard.control_token.clone();
  let mut child = guard.child.take();
  let state_dir = guard.state_dir.clone();
  let expected_pid = guard.expected_pid;
  guard.base_url = None;
  // Keep token only for the shutdown request below.
  drop(guard);

  // Ask Supervisor to stop owned Runtime/Mem0 (best-effort, short timeout path).
  if let (Some(base), Some(token)) = (base, token) {
    let _ = http_json_with_timeout(
      "POST",
      &format!("{base}/v1/shutdown"),
      None,
      Some(&token),
      Duration::from_secs(5),
    );
  }

  // Belt-and-suspenders: Windows does not kill Node Runtime when Supervisor exits.
  // Kill runtime.pid.json from this instance if still alive.
  if let Some(dir) = state_dir.as_ref() {
    force_kill_pid_from_metadata(&dir.join("runtime.pid.json"));
    force_kill_pid_from_metadata(&dir.join("mem0.pid.json"));
  }

  if let Some(child) = child.take() {
    let _ = stop_child_bounded(child);
  } else if let Some(pid) = expected_pid {
    force_kill_process_tree(pid);
  }

  // Best-effort cleanup of active pointer + instance lock.
  let root = crate::packaging::desktop_state_dir();
  let _ = fs::remove_file(root.join("active-instance.json"));
  let _ = fs::remove_file(root.join("tauri-bootstrap-ready.json"));
  let _ = fs::remove_file(root.join("supervisor.instance.lock"));
}

fn stop_child_bounded(mut child: Child) -> bool {
  const ATTEMPTS: usize = 12;

  for _ in 0..ATTEMPTS {
    match child.try_wait() {
      Ok(Some(_)) => return true,
      Ok(None) => thread::sleep(Duration::from_millis(100)),
      Err(_) => break,
    }
  }

  let pid = child.id();
  let _ = child.kill();
  // Never block on Child::wait before forcing the owned tree. The Windows
  // smoke observed Child::wait remaining blocked after kill reported success.
  force_kill_process_tree(pid);

  for _ in 0..ATTEMPTS {
    match child.try_wait() {
      Ok(Some(_)) => return true,
      Ok(None) => thread::sleep(Duration::from_millis(100)),
      Err(_) => return false,
    }
  }
  false
}

/// Force-kill a process tree on Windows (taskkill /T /F). No-op elsewhere / pid 0.
fn force_kill_process_tree(pid: u32) {
  if pid == 0 {
    return;
  }
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = Command::new("kill")
      .args(["-TERM", &pid.to_string()])
      .status();
  }
}

/// Read `{ "pid": N }` metadata and force-kill that tree if present.
fn force_kill_pid_from_metadata(path: &Path) {
  let Ok(text) = fs::read_to_string(path) else {
    return;
  };
  let Ok(value) = serde_json::from_str::<Value>(&text) else {
    return;
  };
  let pid = value
    .get("pid")
    .and_then(|v| v.as_u64())
    .or_else(|| value.get("processId").and_then(|v| v.as_u64()))
    .unwrap_or(0) as u32;
  if pid > 0 {
    force_kill_process_tree(pid);
  }
}

fn start_status_poller(app: AppHandle) {
  thread::spawn(move || {
    let mut last_fingerprint: Option<String> = None;
    loop {
      let (base, token, stop) = {
        let state = app.state::<SupervisorState>();
        let guard = match state.inner.lock() {
          Ok(g) => g,
          Err(_) => break,
        };
        if guard.poll_stop || guard.shutting_down {
          break;
        }
        (
          guard.base_url.clone(),
          guard.control_token.clone(),
          guard.poll_stop,
        )
      };
      if stop {
        break;
      }
      if let (Some(base), Some(token)) = (base, token) {
        if let Ok(snapshot) = http_json("GET", &format!("{base}/v1/status"), None, Some(&token)) {
          // Snapshot must never contain the control token.
          // Skip emit when UI-visible service fields are unchanged (reduces React churn).
          let fingerprint = status_emit_fingerprint(&snapshot);
          if last_fingerprint.as_ref() != Some(&fingerprint) {
            last_fingerprint = Some(fingerprint);
            let _ = app.emit("service.status.changed", snapshot);
          }
        }
      } else {
        break;
      }
      thread::sleep(Duration::from_secs(5));
    }
  });
}

/// Stable fingerprint of status fields that affect the UI (ignores updatedAt).
fn status_emit_fingerprint(snapshot: &Value) -> String {
  let services = snapshot.get("services").cloned().unwrap_or(Value::Null);
  let instance = snapshot
    .get("instanceId")
    .or_else(|| snapshot.get("instance_id"))
    .cloned()
    .unwrap_or(Value::Null);
  let shutting = snapshot
    .get("shuttingDown")
    .or_else(|| snapshot.get("shutting_down"))
    .cloned()
    .unwrap_or(Value::Null);
  // Strip per-check clocks from each service object.
  let stripped = match services {
    Value::Array(items) => Value::Array(
      items
        .into_iter()
        .map(|item| match item {
          Value::Object(mut map) => {
            map.remove("checkedAt");
            map.remove("checked_at");
            map.remove("startedAt");
            map.remove("started_at");
            Value::Object(map)
          }
          other => other,
        })
        .collect(),
    ),
    other => other,
  };
  format!("{instance}|{shutting}|{stripped}")
}

fn require_endpoint(state: &State<'_, SupervisorState>) -> Result<(String, String), String> {
  let guard = state
    .inner
    .lock()
    .map_err(|_| "supervisor lock poisoned".to_string())?;
  if guard.shutting_down {
    return Err("supervisor is shutting down".to_string());
  }
  let base = guard
    .base_url
    .clone()
    .ok_or_else(|| "desktop supervisor is not running".to_string())?;
  let token = guard
    .control_token
    .clone()
    .ok_or_else(|| "desktop supervisor control token missing".to_string())?;
  Ok((base, token))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivePointer {
  instance_id: String,
  pid: u32,
  endpoint_file: String,
}

fn wait_for_active_endpoint(pointer_path: &Path, timeout: Duration) -> Result<EndpointFile, String> {
  let started = std::time::Instant::now();
  while started.elapsed() < timeout {
    if pointer_path.exists() {
      if let Ok(text) = fs::read_to_string(pointer_path) {
        if let Ok(pointer) = serde_json::from_str::<ActivePointer>(&text) {
          if !process_alive(pointer.pid) {
            thread::sleep(Duration::from_millis(200));
            continue;
          }
          let endpoint_path = PathBuf::from(&pointer.endpoint_file);
          if let Ok(endpoint_text) = fs::read_to_string(&endpoint_path) {
            if let Ok(endpoint) = serde_json::from_str::<EndpointFile>(&endpoint_text) {
              // PID + instance must match pointer; refuse mismatched stale files.
              if endpoint.pid == pointer.pid
                && endpoint.instance_id == pointer.instance_id
                && process_alive(endpoint.pid)
                && http_json("GET", &format!("{}/health", endpoint.base_url), None, None).is_ok()
              {
                return Ok(endpoint);
              }
            }
          }
        }
      }
    }
    thread::sleep(Duration::from_millis(200));
  }
  Err("desktop supervisor did not publish a control endpoint in time".to_string())
}

/// Loopback JSON over plain TCP — never shell out to PowerShell/curl.
/// PowerShell was flashing console windows on every 5s status poll ("已退出进程").
fn http_json(
  method: &str,
  url: &str,
  body: Option<&str>,
  token: Option<&str>,
) -> Result<Value, String> {
  let timeout = if method.eq_ignore_ascii_case("GET") {
    Duration::from_secs(5)
  } else {
    Duration::from_secs(60)
  };
  http_json_with_timeout(method, url, body, token, timeout)
}

fn http_json_with_timeout(
  method: &str,
  url: &str,
  body: Option<&str>,
  token: Option<&str>,
  read_timeout: Duration,
) -> Result<Value, String> {
  use std::io::{Read, Write};
  use std::net::TcpStream;

  let parsed = url::Url::parse(url).map_err(|e| format!("invalid supervisor url: {e}"))?;
  if parsed.scheme() != "http" {
    return Err("supervisor control plane must use http".into());
  }
  let host = parsed
    .host_str()
    .ok_or_else(|| "supervisor url missing host".to_string())?
    .to_string();
  let host_l = host.to_ascii_lowercase();
  if host_l != "127.0.0.1" && host_l != "localhost" && host_l != "::1" {
    return Err("supervisor HTTP must stay on loopback".into());
  }
  let port = parsed.port().unwrap_or(80);
  let path = {
    let p = parsed.path();
    let path = if p.is_empty() { "/" } else { p };
    match parsed.query() {
      Some(q) => format!("{path}?{q}"),
      None => path.to_string(),
    }
  };

  let is_get = method.eq_ignore_ascii_case("GET");

  // Prefer IPv4 loopback; `localhost` can resolve to ::1 first on some hosts.
  let connect_host = if host_l == "localhost" || host_l == "::1" {
    "127.0.0.1"
  } else {
    host.as_str()
  };
  let mut stream = TcpStream::connect((connect_host, port))
    .map_err(|e| format!("supervisor connect failed: {e}"))?;
  let _ = stream.set_read_timeout(Some(read_timeout));
  let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

  let body_bytes = if is_get {
    None
  } else {
    Some(body.unwrap_or(""))
  };

  let mut request = format!(
    "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n"
  );
  if let Some(token) = token {
    // Control tokens are hex; never log them.
    request.push_str("X-Yuvi-Control-Token: ");
    request.push_str(token);
    request.push_str("\r\n");
  }
  if let Some(payload) = body_bytes {
    request.push_str("Content-Type: application/json\r\n");
    request.push_str(&format!("Content-Length: {}\r\n\r\n", payload.len()));
    request.push_str(payload);
  } else {
    request.push_str("\r\n");
  }

  stream
    .write_all(request.as_bytes())
    .map_err(|e| format!("supervisor write failed: {e}"))?;

  let mut raw = Vec::new();
  stream
    .read_to_end(&mut raw)
    .map_err(|e| format!("supervisor read failed: {e}"))?;
  let raw_str = String::from_utf8_lossy(&raw);
  let (header_part, body_part) = raw_str
    .split_once("\r\n\r\n")
    .or_else(|| raw_str.split_once("\n\n"))
    .ok_or_else(|| "invalid HTTP response from supervisor".to_string())?;

  let status_line = header_part.lines().next().unwrap_or("");
  let status_code: u16 = status_line
    .split_whitespace()
    .nth(1)
    .and_then(|s| s.parse().ok())
    .unwrap_or(0);
  if !(200..300).contains(&status_code) {
    return Err(format!("supervisor request failed (HTTP {status_code})"));
  }

  let response_body = if header_part
    .to_ascii_lowercase()
    .contains("transfer-encoding: chunked")
  {
    decode_chunked_body(body_part)?
  } else {
    body_part.to_string()
  };

  let text = response_body.trim();
  if text.is_empty() {
    return Ok(Value::Object(serde_json::Map::new()));
  }
  serde_json::from_str(text).map_err(|e| format!("invalid supervisor JSON: {e}"))
}

fn decode_chunked_body(input: &str) -> Result<String, String> {
  let mut rest = input;
  let mut out = String::new();
  loop {
    let (size_line, after) = rest
      .split_once("\r\n")
      .or_else(|| rest.split_once('\n'))
      .ok_or_else(|| "invalid chunked encoding".to_string())?;
    let size_str = size_line.split(';').next().unwrap_or("").trim();
    let size = usize::from_str_radix(size_str, 16)
      .map_err(|_| format!("invalid chunk size '{size_str}'"))?;
    if size == 0 {
      break;
    }
    if after.len() < size {
      return Err("truncated chunked body".into());
    }
    out.push_str(&after[..size]);
    rest = &after[size..];
    if rest.starts_with("\r\n") {
      rest = &rest[2..];
    } else if rest.starts_with('\n') {
      rest = &rest[1..];
    }
  }
  Ok(out)
}

fn process_alive(pid: u32) -> bool {
  if pid == 0 {
    return false;
  }
  #[cfg(target_os = "windows")]
  {
    // Native OpenProcess — no PowerShell console flash.
    process_alive_windows(pid)
  }
  #[cfg(not(target_os = "windows"))]
  {
    Command::new("kill")
      .args(["-0", &pid.to_string()])
      .status()
      .map(|s| s.success())
      .unwrap_or(false)
  }
}

#[cfg(target_os = "windows")]
fn process_alive_windows(pid: u32) -> bool {
  #[link(name = "kernel32")]
  extern "system" {
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetExitCodeProcess(handle: *mut std::ffi::c_void, exit_code: *mut u32) -> i32;
  }
  const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
  const STILL_ACTIVE: u32 = 259;
  unsafe {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
      return false;
    }
    let mut code: u32 = 0;
    let ok = GetExitCodeProcess(handle, &mut code);
    CloseHandle(handle);
    ok != 0 && code == STILL_ACTIVE
  }
}

fn resolve_packaged_resource_root(app: &AppHandle) -> Result<PathBuf, String> {
  // Prefer Tauri resource_dir (release install layout).
  if let Ok(resource_dir) = app.path().resource_dir() {
    // Prefer generated/win32-x64 under resource_dir if present (dev staging),
    // else resource_dir itself when it already contains runtime/supervisor.
    let nested = resource_dir.join("generated").join("win32-x64");
    if nested.join("runtime").join("runtime-manifest.json").is_file() {
      return Ok(nested);
    }
    if resource_dir
      .join("runtime")
      .join("runtime-manifest.json")
      .is_file()
    {
      return Ok(resource_dir);
    }
  }
  // Dev-only convenience: resolve crate-local generated/ when force-packaged.
  if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
    let generated = PathBuf::from(manifest_dir)
      .join("generated")
      .join("win32-x64");
    if generated
      .join("runtime")
      .join("runtime-manifest.json")
      .is_file()
    {
      return Ok(generated);
    }
  }
  Err(
    "packaging error: Supervisor resource missing (expected runtime/ and supervisor/ under resource dir)"
      .into(),
  )
}

fn which_command(name: &str) -> Option<PathBuf> {
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    let candidate = dir.join(name);
    if candidate.exists() {
      return Some(candidate);
    }
    let with_exe = dir.join(format!("{name}.exe"));
    if with_exe.exists() {
      return Some(with_exe);
    }
    let with_cmd = dir.join(format!("{name}.cmd"));
    if with_cmd.exists() {
      return Some(with_cmd);
    }
  }
  None
}

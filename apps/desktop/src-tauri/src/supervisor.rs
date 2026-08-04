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
        ]);
        cmd
      } else if let Some(pnpm) = which_command("pnpm") {
        let mut cmd = Command::new(pnpm);
        cmd.args([
          "exec",
          "tsx",
          dev.supervisor_script.to_string_lossy().as_ref(),
          "--repo-root",
        ])
        .arg(&dev.repo_root);
        cmd
      } else {
        let node = which_command("node")
          .ok_or_else(|| "node/pnpm is required for desktop supervisor".to_string())?;
        let mut cmd = Command::new(node);
        cmd.arg("--import")
          .arg("tsx")
          .arg(&dev.supervisor_script)
          .arg("--repo-root")
          .arg(&dev.repo_root);
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

  // Apply full user config (incl. secrets + unsets) as dynamic overrides, then bootstrap.
  let token = endpoint.control_token.clone();
  let base_url = endpoint.base_url.clone();
  let config_body = app
    .try_state::<crate::config::ConfigState>()
    .and_then(|cfg| cfg.service.supervisor_config_push().ok())
    .and_then(|payload| serde_json::to_string(&payload).ok());
  thread::spawn(move || {
    if let Some(body) = config_body {
      // Never log body — may contain secrets.
      let _ = http_json(
        "POST",
        &format!("{base_url}/v1/config"),
        Some(&body),
        Some(&token),
      );
    }
    let _ = http_json(
      "POST",
      &format!("{base_url}/v1/bootstrap"),
      None,
      Some(&token),
    );
  });

  start_status_poller(app.clone());
  Ok(())
}

fn is_secret_env_key(key: &str) -> bool {
  matches!(key, "DEEPSEEK_API_KEY" | "DATABASE_URL")
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
  guard.base_url = None;
  // Keep token only for the shutdown request below.
  drop(guard);

  if let (Some(base), Some(token)) = (base, token) {
    let _ = http_json(
      "POST",
      &format!("{base}/v1/shutdown"),
      None,
      Some(&token),
    );
  }
  if let Some(mut child) = child.take() {
    // Bounded wait for supervisor process to exit after graceful shutdown.
    for _ in 0..20 {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) => thread::sleep(Duration::from_millis(150)),
        Err(_) => break,
      }
    }
    let _ = child.kill();
    let _ = child.wait();
  }

  // Best-effort cleanup of active pointer (instance endpoint deleted by supervisor process).
  let _ = fs::remove_file(
    crate::packaging::desktop_state_dir().join("active-instance.json"),
  );
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

fn http_json(
  method: &str,
  url: &str,
  body: Option<&str>,
  token: Option<&str>,
) -> Result<Value, String> {
  #[cfg(target_os = "windows")]
  {
    let token_header = token
      .map(|t| format!("$h['X-Yuvi-Control-Token']='{t}'; "))
      .unwrap_or_default();
    // Escape single quotes for PowerShell single-quoted strings in URI only.
    let safe_url = url.replace('\'', "''");
    let script = if method == "GET" {
      format!(
        "$ProgressPreference='SilentlyContinue'; $h=@{{}}; {token_header}try {{ (Invoke-WebRequest -UseBasicParsing -Method GET -Uri '{safe_url}' -Headers $h -TimeoutSec 5).Content }} catch {{ exit 2 }}"
      )
    } else {
      let body_arg = body.unwrap_or("").replace('\'', "''");
      if body_arg.is_empty() {
        format!(
          "$ProgressPreference='SilentlyContinue'; $h=@{{}}; {token_header}try {{ (Invoke-WebRequest -UseBasicParsing -Method POST -Uri '{safe_url}' -Headers $h -TimeoutSec 60).Content }} catch {{ exit 2 }}"
        )
      } else {
        format!(
          "$ProgressPreference='SilentlyContinue'; $h=@{{'Content-Type'='application/json'}}; {token_header}try {{ (Invoke-WebRequest -UseBasicParsing -Method POST -Uri '{safe_url}' -Headers $h -Body '{body_arg}' -TimeoutSec 60).Content }} catch {{ exit 2 }}"
        )
      }
    };
    let output = Command::new("powershell.exe")
      .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
      .output()
      .map_err(|e| e.to_string())?;
    if !output.status.success() {
      return Err("supervisor request failed".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
      return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_str(&text).map_err(|e| format!("invalid supervisor JSON: {e}"))
  }

  #[cfg(not(target_os = "windows"))]
  {
    let mut command = Command::new("curl");
    command.args(["-sS", "-X", method, url, "--max-time", "60"]);
    if let Some(token) = token {
      command.args(["-H", &format!("X-Yuvi-Control-Token: {token}")]);
    }
    if method != "GET" {
      command.args([
        "-H",
        "content-type: application/json",
        "-d",
        body.unwrap_or("{}"),
      ]);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
      return Err("supervisor request failed".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str(&text).map_err(|e| format!("invalid supervisor JSON: {e}"))
  }
}

fn process_alive(pid: u32) -> bool {
  if pid == 0 {
    return false;
  }
  #[cfg(target_os = "windows")]
  {
    let output = Command::new("powershell.exe")
      .args([
        "-NoProfile",
        "-Command",
        &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"),
      ])
      .output();
    matches!(output, Ok(o) if o.status.success())
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

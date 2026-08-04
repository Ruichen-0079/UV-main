//! Development vs packaged layout resolution for the desktop supervisor.
//! No secrets, tokens, or user credentials appear in argv or public diagnostics.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorLaunchMode {
  Development,
  Packaged,
}

#[derive(Debug, Clone)]
pub struct DevelopmentLaunch {
  pub repo_root: PathBuf,
  pub supervisor_script: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PackagedLaunch {
  pub resource_root: PathBuf,
  pub supervisor_exe: Option<PathBuf>,
  pub supervisor_cjs: PathBuf,
  pub bundled_node: PathBuf,
  pub runtime_manifest: PathBuf,
  pub state_root: PathBuf,
}

#[derive(Debug, Clone)]
pub enum SupervisorLaunchPlan {
  Development(DevelopmentLaunch),
  Packaged(PackagedLaunch),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagingDiagnostics {
  pub mode: String,
  pub ok: bool,
  pub error: Option<String>,
  pub resource_root: Option<String>,
  pub supervisor_exe: Option<String>,
  pub supervisor_cjs: Option<String>,
  pub bundled_node: Option<String>,
  pub runtime_manifest: Option<String>,
  pub state_root: Option<String>,
  pub repo_root: Option<String>,
}

impl PackagingDiagnostics {
  pub fn from_plan(plan: &SupervisorLaunchPlan) -> Self {
    match plan {
      SupervisorLaunchPlan::Development(dev) => Self {
        mode: "development".into(),
        ok: true,
        error: None,
        resource_root: None,
        supervisor_exe: None,
        supervisor_cjs: None,
        bundled_node: None,
        runtime_manifest: None,
        state_root: None,
        repo_root: Some(dev.repo_root.display().to_string()),
      },
      SupervisorLaunchPlan::Packaged(pkg) => Self {
        mode: "packaged".into(),
        ok: true,
        error: None,
        resource_root: Some(pkg.resource_root.display().to_string()),
        supervisor_exe: pkg
          .supervisor_exe
          .as_ref()
          .map(|p| p.display().to_string()),
        supervisor_cjs: Some(pkg.supervisor_cjs.display().to_string()),
        bundled_node: Some(pkg.bundled_node.display().to_string()),
        runtime_manifest: Some(pkg.runtime_manifest.display().to_string()),
        state_root: Some(pkg.state_root.display().to_string()),
        repo_root: None,
      },
    }
  }

  pub fn error(mode: &str, message: impl Into<String>) -> Self {
    Self {
      mode: mode.into(),
      ok: false,
      error: Some(message.into()),
      resource_root: None,
      supervisor_exe: None,
      supervisor_cjs: None,
      bundled_node: None,
      runtime_manifest: None,
      state_root: None,
      repo_root: None,
    }
  }
}

/// Default mode: debug → development, release → packaged.
/// Override with YUVI_SUPERVISOR_MODE=development|packaged (tests only).
pub fn resolve_launch_mode() -> SupervisorLaunchMode {
  if let Ok(raw) = std::env::var("YUVI_SUPERVISOR_MODE") {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized == "packaged" {
      return SupervisorLaunchMode::Packaged;
    }
    if normalized == "development" || normalized == "dev" {
      return SupervisorLaunchMode::Development;
    }
  }
  if cfg!(debug_assertions) {
    SupervisorLaunchMode::Development
  } else {
    SupervisorLaunchMode::Packaged
  }
}

pub fn resolve_development_launch(repo_root: PathBuf) -> Result<DevelopmentLaunch, String> {
  let supervisor_script = repo_root
    .join("scripts")
    .join("yuvi-desktop-supervisor.mts");
  if !supervisor_script.is_file() {
    return Err(format!(
      "missing supervisor script: {}",
      supervisor_script.display()
    ));
  }
  Ok(DevelopmentLaunch {
    repo_root,
    supervisor_script,
  })
}

/// Resolve packaged resources under Tauri resource_dir (or explicit override).
/// Release never falls back to pnpm/tsx/system node.
pub fn resolve_packaged_launch(
  resource_root: PathBuf,
  state_root: PathBuf,
) -> Result<PackagedLaunch, String> {
  if !resource_root.is_dir() {
    return Err(format!(
      "Supervisor resource missing: {}",
      resource_root.display()
    ));
  }

  let supervisor_dir = resource_root.join("supervisor");
  let runtime_dir = resource_root.join("runtime");

  let supervisor_cjs = supervisor_dir.join("yuvi-desktop-supervisor.cjs");
  if !supervisor_cjs.is_file() {
    return Err(format!(
      "Supervisor resource missing (cjs): {}",
      supervisor_cjs.display()
    ));
  }

  let supervisor_exe_candidate = supervisor_dir.join("yuvi-desktop-supervisor.exe");
  let supervisor_exe = if supervisor_exe_candidate.is_file() {
    Some(supervisor_exe_candidate)
  } else {
    None
  };

  let bundled_node = runtime_dir.join("node.exe");
  if !bundled_node.is_file() {
    return Err(format!(
      "Bundled Node missing: {}",
      bundled_node.display()
    ));
  }

  let runtime_manifest = runtime_dir.join("runtime-manifest.json");
  if !runtime_manifest.is_file() {
    return Err(format!(
      "Runtime manifest invalid or missing: {}",
      runtime_manifest.display()
    ));
  }
  // Lightweight schema check without secrets.
  let manifest_text = fs::read_to_string(&runtime_manifest)
    .map_err(|e| format!("Runtime manifest unreadable: {e}"))?;
  if !manifest_text.contains("\"schemaVersion\"") || !manifest_text.contains("yuvi-runtime-server")
  {
    return Err("Runtime manifest invalid: expected schemaVersion and runtime entry".into());
  }
  let runtime_entry = runtime_dir.join("yuvi-runtime-server.mjs");
  if !runtime_entry.is_file() {
    return Err(format!(
      "Runtime entry missing: {}",
      runtime_entry.display()
    ));
  }

  fs::create_dir_all(&state_root).map_err(|e| format!("state root unavailable: {e}"))?;

  Ok(PackagedLaunch {
    resource_root,
    supervisor_exe,
    supervisor_cjs,
    bundled_node,
    runtime_manifest,
    state_root,
  })
}

/// Build argv for packaged supervisor. Never includes secrets or tokens.
pub fn packaged_supervisor_args(plan: &PackagedLaunch) -> Vec<String> {
  vec![
    "--mode".into(),
    "packaged".into(),
    "--resource-root".into(),
    plan.resource_root.display().to_string(),
    "--state-root".into(),
    plan.state_root.display().to_string(),
    "--runtime-manifest".into(),
    plan.runtime_manifest.display().to_string(),
  ]
}

/// How Rust will launch the packaged supervisor process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackagedSupervisorCommand {
  /// Standalone pkg-produced executable.
  Exe { file: PathBuf, args: Vec<String> },
  /// Fallback: bundled node.exe + supervisor.cjs (never system PATH node).
  NodeCjs {
    node: PathBuf,
    cjs: PathBuf,
    args: Vec<String>,
  },
}

/// Prefer supervisor exe when present; otherwise use bundled node + cjs.
/// Never returns a PATH-based node.
pub fn select_packaged_supervisor_command(plan: &PackagedLaunch) -> PackagedSupervisorCommand {
  let args = packaged_supervisor_args(plan);
  if let Some(exe) = &plan.supervisor_exe {
    if exe.is_file() {
      return PackagedSupervisorCommand::Exe {
        file: exe.clone(),
        args,
      };
    }
  }
  PackagedSupervisorCommand::NodeCjs {
    node: plan.bundled_node.clone(),
    cjs: plan.supervisor_cjs.clone(),
    args,
  }
}

pub fn assert_no_secret_in_args(args: &[String]) -> Result<(), String> {
  let joined = args.join(" ").to_ascii_lowercase();
  for needle in ["deepseek_api_key", "database_url", "sk-", "password=", "bearer "] {
    if joined.contains(needle) {
      return Err("secret-like content must not appear in supervisor argv".into());
    }
  }
  Ok(())
}

pub fn discover_repo_root() -> Result<PathBuf, String> {
  let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
  for _ in 0..8 {
    if dir.join("pnpm-workspace.yaml").exists() && dir.join("apps").join("desktop").exists() {
      return Ok(dir);
    }
    if !dir.pop() {
      break;
    }
  }
  if let Ok(exe) = std::env::current_exe() {
    let mut dir = exe;
    for _ in 0..10 {
      if dir.join("pnpm-workspace.yaml").exists() {
        return Ok(dir);
      }
      if !dir.pop() {
        break;
      }
    }
  }
  Err("could not locate YUVI repository root for supervisor".to_string())
}

pub fn desktop_state_dir() -> PathBuf {
  if let Ok(local) = std::env::var("LOCALAPPDATA") {
    return PathBuf::from(local).join("YUVI").join("DesktopSupervisor");
  }
  std::env::temp_dir().join("YUVI-DesktopSupervisor")
}

/// Prefer resource_dir; fall back to generated layout next to the crate for unit tests.
pub fn default_resource_root_for_tests(base: &Path) -> PathBuf {
  base.join("generated").join("win32-x64")
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use tempfile::tempdir;

  #[test]
  fn development_layout_resolves_repo_script() {
    let dir = tempdir().unwrap();
    let scripts = dir.path().join("scripts");
    fs::create_dir_all(&scripts).unwrap();
    fs::write(scripts.join("yuvi-desktop-supervisor.mts"), "//x\n").unwrap();
    let launch = resolve_development_launch(dir.path().to_path_buf()).unwrap();
    assert!(launch.supervisor_script.ends_with("yuvi-desktop-supervisor.mts"));
  }

  #[test]
  fn packaged_layout_resolves_resource_tree() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("res");
    let sup = root.join("supervisor");
    let rt = root.join("runtime");
    fs::create_dir_all(&sup).unwrap();
    fs::create_dir_all(&rt).unwrap();
    fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "module.exports={}\n").unwrap();
    fs::write(rt.join("node.exe"), b"MZ").unwrap();
    fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
    fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
    let state = dir.path().join("state");
    let launch = resolve_packaged_launch(root, state).unwrap();
    assert!(launch.supervisor_cjs.is_file());
    assert!(launch.bundled_node.is_file());
    assert!(launch.runtime_manifest.is_file());
  }

  #[test]
  fn packaged_missing_resource_errors_clearly() {
    let dir = tempdir().unwrap();
    let err = resolve_packaged_launch(dir.path().join("missing"), dir.path().join("state"))
      .unwrap_err();
    assert!(err.to_lowercase().contains("resource"));
  }

  #[test]
  fn packaged_paths_with_spaces_work() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("res with spaces");
    let sup = root.join("supervisor");
    let rt = root.join("runtime");
    fs::create_dir_all(&sup).unwrap();
    fs::create_dir_all(&rt).unwrap();
    fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
    fs::write(rt.join("node.exe"), b"MZ").unwrap();
    fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
    let mut manifest = fs::File::create(rt.join("runtime-manifest.json")).unwrap();
    write!(
      manifest,
      r#"{{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}}"#
    )
    .unwrap();
    let state = dir.path().join("state with spaces");
    let launch = resolve_packaged_launch(root, state).unwrap();
    let args = packaged_supervisor_args(&launch);
    assert!(args.iter().any(|a| a.contains(" ")));
    assert_no_secret_in_args(&args).unwrap();
  }

  #[test]
  fn packaged_paths_with_non_ascii_work() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("资源目录");
    let sup = root.join("supervisor");
    let rt = root.join("runtime");
    fs::create_dir_all(&sup).unwrap();
    fs::create_dir_all(&rt).unwrap();
    fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
    fs::write(rt.join("node.exe"), b"MZ").unwrap();
    fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
    fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
    let launch = resolve_packaged_launch(root, dir.path().join("状态")).unwrap();
    assert!(launch.resource_root.display().to_string().contains("资源"));
  }

  #[test]
  fn secret_not_in_argv() {
    let args = vec![
      "--mode".into(),
      "packaged".into(),
      "--resource-root".into(),
      "C:\\YUVI\\resources".into(),
    ];
    assert_no_secret_in_args(&args).unwrap();
    let bad = vec!["--env".into(), "DEEPSEEK_API_KEY=sk-test".into()];
    assert!(assert_no_secret_in_args(&bad).is_err());
  }

  #[test]
  fn release_default_mode_is_packaged_in_logic() {
    // Unit test of override only — debug builds default to Development.
    std::env::set_var("YUVI_SUPERVISOR_MODE", "packaged");
    assert_eq!(resolve_launch_mode(), SupervisorLaunchMode::Packaged);
    std::env::set_var("YUVI_SUPERVISOR_MODE", "development");
    assert_eq!(resolve_launch_mode(), SupervisorLaunchMode::Development);
    std::env::remove_var("YUVI_SUPERVISOR_MODE");
  }

  #[test]
  fn packaged_prefers_exe_when_present() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("res");
    let sup = root.join("supervisor");
    let rt = root.join("runtime");
    fs::create_dir_all(&sup).unwrap();
    fs::create_dir_all(&rt).unwrap();
    fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
    fs::write(sup.join("yuvi-desktop-supervisor.exe"), b"MZ").unwrap();
    fs::write(rt.join("node.exe"), b"MZ").unwrap();
    fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
    fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
    let plan = resolve_packaged_launch(root, dir.path().join("state")).unwrap();
    match select_packaged_supervisor_command(&plan) {
      PackagedSupervisorCommand::Exe { file, args } => {
        assert!(file.ends_with("yuvi-desktop-supervisor.exe"));
        assert_no_secret_in_args(&args).unwrap();
        assert!(args.iter().any(|a| a == "packaged"));
      }
      other => panic!("expected Exe, got {other:?}"),
    }
  }

  #[test]
  fn packaged_fallback_uses_bundled_node_not_path() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("res");
    let sup = root.join("supervisor");
    let rt = root.join("runtime");
    fs::create_dir_all(&sup).unwrap();
    fs::create_dir_all(&rt).unwrap();
    fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
    // No supervisor exe → node+cjs fallback
    fs::write(rt.join("node.exe"), b"MZ").unwrap();
    fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
    fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
    let plan = resolve_packaged_launch(root.clone(), dir.path().join("state")).unwrap();
    match select_packaged_supervisor_command(&plan) {
      PackagedSupervisorCommand::NodeCjs { node, cjs, args } => {
        assert!(node.ends_with("node.exe"));
        assert!(node.starts_with(&root));
        assert!(cjs.ends_with("yuvi-desktop-supervisor.cjs"));
        assert_no_secret_in_args(&args).unwrap();
        // Fallback must not invent system node path.
        assert!(!node.to_string_lossy().to_ascii_lowercase().contains("program files"));
      }
      other => panic!("expected NodeCjs fallback, got {other:?}"),
    }
  }
}

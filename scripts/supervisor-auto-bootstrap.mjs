/**
 * Contained automatic Supervisor bootstrap.
 * A rejection must never become an unhandled Promise rejection.
 */
const SECRET_LIKE =
  /\b(YUVI_POSTGRES_PASSWORD|DATABASE_URL|MEM0_PG_CONNECTION_STRING|YUVI_INSTALLER_SMOKE_CRED_SECRET)\b\s*[=:]\s*\S+/gi;

export function redactAutomaticBootstrapFailureText(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(SECRET_LIKE, "$1=[redacted]");
  out = out.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]");
  return out.slice(0, 240);
}

export function formatAutomaticBootstrapFailureDiagnostic(
  error,
  snapshot = null,
  { secrets = [] } = {}
) {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "bootstrap failed");
  const code =
    error && typeof error === "object" && error.code != null
      ? String(error.code).slice(0, 64)
      : "BOOTSTRAP_FAILED";
  const migration = snapshot?.postgres?.migration ?? null;
  return {
    ok: false,
    event: "supervisor.bootstrap_failed",
    errorName: String(error?.name || "Error").slice(0, 80),
    errorCode: code,
    message: redactAutomaticBootstrapFailureText(rawMessage, secrets),
    postgresMode:
      typeof snapshot?.postgres?.mode === "string" ? snapshot.postgres.mode.slice(0, 16) : null,
    schemaReady: migration?.schemaReady === true,
    memorySearchStatus:
      typeof migration?.memorySearchStatus === "string"
        ? migration.memorySearchStatus.slice(0, 32)
        : null
  };
}

export function startAutomaticSupervisorBootstrap(
  supervisor,
  { log = console.log, snapshotOf = (instance) => instance?.snapshot?.() ?? null } = {}
) {
  return Promise.resolve()
    .then(() => supervisor.bootstrap())
    .then((snap) => {
      const services = Array.isArray(snap?.services) ? snap.services : [];
      log(
        JSON.stringify({
          ok: true,
          event: "supervisor.bootstrap",
          services: services.map((service) => ({
            id: service.id,
            status: service.status,
            ownership: service.ownership
          }))
        })
      );
    })
    .catch((error) => {
      try {
        let snapshot = null;
        try {
          snapshot = snapshotOf(supervisor);
        } catch {
          snapshot = null;
        }
        log(JSON.stringify(formatAutomaticBootstrapFailureDiagnostic(error, snapshot)));
      } catch {
        /* never rethrow — control plane must stay alive */
      }
    });
}

import { spawn } from "node:child_process";

/** One fixed Linux checkout service; never accepts a unit name or shell command from HTTP. */
export function restartDailyUseServices(): void {
  const child = spawn("systemctl", ["--user", "restart", "--no-block", "yuvi-daily.service"], {
    stdio: "ignore"
  });
  child.on("error", () => {
    /* A disconnected service will be reported by live status. */
  });
  child.unref();
}

import fs from "node:fs";
import { Writable } from "node:stream";

/** Two bounded files per owned stdout/stderr stream; never touches durable stores. */
export function boundedLog(file: string, limit = 2 * 1024 * 1024): Writable {
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
    if (bytes > limit) {
      fs.truncateSync(file, 0);
      bytes = 0;
    }
  } catch {
    /* New log. */
  }
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        const data = chunk.length > limit ? chunk.subarray(chunk.length - limit) : chunk;
        if (bytes + data.length > limit) {
          fs.rmSync(`${file}.1`, { force: true });
          if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
          bytes = 0;
        }
        fs.appendFileSync(file, data, { mode: 0o600 });
        bytes += data.length;
      } catch {
        // A full/unwritable diagnostic disk must not crash or block the service tree.
      }
      done();
    }
  });
}

/** Startup-only TTL for known logs in inactive instance directories, never directory removal. */
export function pruneInactiveLogs(root: string, now = Date.now()): void {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry.name)
      )
        continue;
      const dir = `${root}/${entry.name}`;
      const names = fs.readdirSync(dir);
      const possiblyLive = names
        .filter((name) => name.endsWith(".pid.json"))
        .some((name) => {
          try {
            const data = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
            const pid = data.pid ?? data.processId;
            if (!Number.isInteger(pid) || pid < 1) return true;
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code !== "ESRCH";
            }
          } catch {
            return true;
          }
        });
      if (possiblyLive) continue;
      for (const name of names) {
        if (
          !/^(runtime|mem0|local-stt|tts-wrapper|tts-upstream|supervisor-exit)\.log(?:\.err)?(?:\.1)?$/.test(
            name
          )
        )
          continue;
        const file = `${dir}/${name}`;
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
      }
    }
  } catch {
    /* Best effort: cleanup must never prevent startup. */
  }
}

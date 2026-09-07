import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
test(
  "installer retains config, supports paths with spaces, removes only launcher files",
  { skip: process.platform !== "linux" },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi daily-"));
    try {
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "systemctl"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls"\n',
        { mode: 0o700 }
      );
      const config = path.join(home, "retained config");
      fs.mkdirSync(config);
      fs.writeFileSync(path.join(config, ".env.local"), "PRIVATE_SENTINEL=never-export\n");
      const data = path.join(home, "data");
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "durable-marker"), "preserve");
      const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: data,
        YUVI_RUNTIME_ENV_DIR: config,
        PATH: `${bin}:/usr/bin:/bin`
      };
      const run = (action) =>
        spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/install-daily-use-linux.mts", action],
          { cwd: root, env, encoding: "utf8" }
        );
      assert.equal(run("install").status, 0);
      const unit = path.join(env.XDG_CONFIG_HOME, "systemd/user/yuvi-daily.service");
      const text = fs.readFileSync(unit, "utf8");
      assert(text.includes(`YUVI_RUNTIME_ENV_DIR=${config}`));
      assert(!text.includes("never-export"));
      assert(!text.includes("yuvi-ollama"));
      assert.equal(fs.statSync(unit).mode & 0o777, 0o600);
      for (const action of ["start", "restart", "stop", "install", "uninstall"])
        assert.equal(run(action).status, 0, action);
      assert(!fs.existsSync(unit));
      assert.equal(fs.readFileSync(path.join(data, "durable-marker"), "utf8"), "preserve");
      assert(fs.existsSync(path.join(config, ".env.local")));
      const calls = fs.readFileSync(path.join(home, "calls"), "utf8");
      assert(calls.includes("disable --now yuvi-daily.service"));
      assert(!/postgres|ollama/.test(calls));
      assert.notEqual(run("purge").status, 0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

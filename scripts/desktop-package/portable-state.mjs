import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PRODUCT_KIND = "yuvi-linux-daily-packaged";
const PRODUCT_PLATFORM = "linux-x64";
const PRODUCT_VERSION = /^\d+\.\d+\.\d+$/;
const CHECKOUT_SHA = /^[a-f0-9]{40}$/;

export function readPortablePackageIdentity(packageRoot) {
  const manifestPath = path.join(packageRoot, "install-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Portable package identity is unavailable.");
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.kind !== PRODUCT_KIND ||
    manifest?.platform !== PRODUCT_PLATFORM ||
    typeof manifest?.version !== "string" ||
    !PRODUCT_VERSION.test(manifest.version) ||
    typeof manifest?.checkoutSha !== "string" ||
    !CHECKOUT_SHA.test(manifest.checkoutSha)
  ) {
    throw new Error("Portable package identity is invalid.");
  }
  return Object.freeze({ version: manifest.version, checkoutSha: manifest.checkoutSha });
}

export function resolvePortableStateRoot({
  packageRoot,
  env = process.env,
  home = os.homedir(),
  identity
}) {
  const packageIdentity = identity ?? readPortablePackageIdentity(packageRoot);
  const explicit = env.YUVI_PORTABLE_STATE_ROOT?.trim();
  const dataHome =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(home, ".local/share");
  const state = path.resolve(
    explicit || path.join(dataHome, "YUVI", "portable", packageIdentity.version)
  );
  const realPackageRoot = fs.realpathSync(packageRoot);
  if (state === realPackageRoot || state.startsWith(realPackageRoot + path.sep)) {
    throw new Error("Portable state must be outside the package tree.");
  }
  return state;
}

export function resolvePortableStateDirs(stateRoot) {
  return Object.fromEntries(
    ["config", "data", "cache", "tmp", "supervisor", "home"].map((key) => [
      key,
      path.join(stateRoot, key)
    ])
  );
}

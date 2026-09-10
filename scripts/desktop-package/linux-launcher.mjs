/** Public extract-and-run owner; service lifecycle remains DesktopSupervisor's. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portableSecretNamespace, readPortablePackageIdentity, resolvePortableStateDirs, resolvePortableStateRoot } from './portable-state.mjs';
const root = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const packageIdentity = readPortablePackageIdentity(root);
const secretNamespace = portableSecretNamespace(packageIdentity);
const state = resolvePortableStateRoot({ packageRoot: root, identity: packageIdentity });
const dirs = resolvePortableStateDirs(state);
process.umask(0o077);
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const pointer = path.join(dirs.supervisor, 'active-instance.json');
const desktopShell = path.join(root, 'desktop', 'yuvi-desktop');
if (!fs.existsSync(desktopShell)) throw new Error('Portable desktop shell is missing.');
async function control(route) {
  const active = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (!path.resolve(active.endpointFile).startsWith(dirs.supervisor + path.sep)) throw new Error('No active instance at this portable location.');
  const endpoint = JSON.parse(fs.readFileSync(active.endpointFile, 'utf8'));
  if (endpoint.instanceId !== active.instanceId || endpoint.pid !== active.pid || endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port)) throw new Error('Invalid portable instance identity.');
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, { method: route === '/v1/status' ? 'GET' : 'POST', headers: { 'x-yuvi-control-token': endpoint.controlToken }, signal: AbortSignal.timeout(90_000), redirect: 'error' });
  if (!response.ok) throw new Error('Portable instance is unavailable.');
  const result = await response.json();
  if (route === '/v1/status' && result.instanceId !== active.instanceId) throw new Error('Portable instance identity changed.');
  return result;
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop the other application before launching this portable copy.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
const command = process.argv[2] || 'start';
try {
  if (command === 'status') {
    const status = await control('/v1/status');
    console.log(JSON.stringify({ running: true, services: status.services.map(s => ({ id: s.id, status: s.status })) }, null, 2));
  } else if (command === 'stop') {
    await control('/v1/shutdown');
    console.log('YUVI shutdown requested.');
  } else if (command === 'start') {
    const runtimePort = 16121, webPort = 15173, sttPort = 19876;
    for (const port of [runtimePort, webPort, sttPort]) await available(port);
    // Parent provider credentials and Installed state never cross the Portable boundary.
    // Durable Product configuration is restored from this release's versioned config root.
    const guiSessionEnv = Object.fromEntries(
      ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']
        .filter(key => typeof process.env[key] === 'string' && process.env[key])
        .map(key => [key, process.env[key]])
    );
    const env = {
      ...guiSessionEnv,
      PATH: '/usr/bin:/bin', HOME: dirs.home, LANG: process.env.LANG || 'C.UTF-8',
      XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache,
      TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
      YUVI_CONFIG_ROOT: dirs.config, YUVI_DATA_ROOT: dirs.data, YUVI_CACHE_ROOT: dirs.cache,
      YUVI_RUNTIME_ENV_DIR: dirs.config, YUVI_SUPERVISOR_STATE_ROOT: dirs.supervisor,
      YUVI_SECRET_NAMESPACE: secretNamespace,
      // A9 owns packaged Mem0/PostgreSQL distribution and lifecycle. Until those artifacts are
      // present, retain only the explicit external-memory bootstrap guard instead of forcing
      // unrelated Product routing/defaults back to legacy values on every Portable restart.
      YUVI_PACKAGED_EXTERNAL_SIDECARS: '1', YUVI_POSTGRES_MODE: 'external', YUVI_AUTOSTART_MEM0: '0',
      SERVER_HOST: '127.0.0.1', SERVER_PORT: String(runtimePort), LOCAL_STT_BASE_URL: `http://127.0.0.1:${sttPort}`,
      LOCAL_TTS_BASE_URL: 'http://127.0.0.1:19881', GPT_SOVITS_TTS_UPSTREAM_URL: 'http://127.0.0.1:19880'
    };
    const node = path.join(root, 'runtime', 'node');
    const supervisor = spawn(node, [path.join(root, 'supervisor', 'yuvi-desktop-supervisor.cjs'), '--mode', 'packaged', '--resource-root', root, '--state-root', dirs.data, '--runtime-manifest', path.join(root, 'runtime', 'runtime-manifest.json')], { cwd: state, env, stdio: 'inherit' });
    const desktopEnv = { ...env, YUVI_DESKTOP_SUPERVISOR_BINDING: 'attach' };
    if (!process.env.GDK_BACKEND && guiSessionEnv.WAYLAND_DISPLAY && guiSessionEnv.DISPLAY) {
      desktopEnv.GDK_BACKEND = 'x11';
    } else if (process.env.GDK_BACKEND) {
      desktopEnv.GDK_BACKEND = process.env.GDK_BACKEND;
    }
    let web, desktop, closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      supervisor.kill('SIGTERM');
      web?.kill('SIGTERM');
      desktop?.kill('SIGTERM');
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    supervisor.once('error', stop);
    supervisor.once('exit', code => {
      closing = true;
      web?.kill('SIGTERM');
      desktop?.kill('SIGTERM');
      process.exitCode = code || 0;
    });
    const deadline = Date.now() + 90_000;
    while (!closing) {
      try {
        const status = await control('/v1/status');
        const runtime = status.services.find(s => s.id === 'runtime');
        if (runtime?.ownership === 'external') throw new Error('Runtime port belongs to another instance.');
        if (runtime?.status === 'healthy' && runtime.ownership === 'owned') break;
      } catch (error) { if (error.message.includes('another instance')) { stop(); throw error; } }
      if (Date.now() >= deadline) { stop(); throw new Error('Runtime did not become ready. Inspect the portable DATA instances logs.'); }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!closing) {
      web = spawn(node, [path.join(root, 'web', 'static-server.mjs'), '--root', path.join(root, 'web', 'dist'), '--port', String(webPort), '--runtime-port', String(runtimePort)], { cwd: state, env, stdio: 'inherit' });
      web.once('error', stop); web.once('exit', stop);
      desktop = spawn(desktopShell, [], { cwd: state, env: desktopEnv, stdio: 'inherit' });
      desktop.once('error', stop); desktop.once('exit', stop);
      console.log(`YUVI desktop shell started. Browser fallback: http://127.0.0.1:${webPort}/#/webui\nRun ./yuvi stop to shut down.`);
    }
  } else throw new Error('Usage: ./yuvi [start|stop|status]');
} catch (error) { console.error(error.message); process.exitCode = 1; }

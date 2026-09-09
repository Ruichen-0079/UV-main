import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, "linux-static-web-server.mjs");

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  server.close();
  await once(server, "close");
  return port;
}

async function waitForListening(child) {
  let output = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes('"event":"web.listening"')) return;
  }
  throw new Error("static WebUI exited before listening: " + output);
}

async function upgrade(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  socket.write(
    "GET /ws?dashboard=true HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Key: dGVzdA==\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n"
  );
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    response += chunk;
  });
  await once(socket, "close");
  return response;
}

test("portable static WebUI proxies /ws to its explicit Runtime port", async (t) => {
  let observed = null;
  const runtime = http.createServer();
  runtime.on("upgrade", (req, socket) => {
    observed = { url: req.url, host: req.headers.host };
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n\r\n"
    );
  });
  const runtimePort = await listen(runtime);
  t.after(async () => {
    runtime.close();
    if (runtime.listening) await once(runtime, "close");
  });

  const webPort = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-static-web-ws-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>YUVI</title>");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const child = spawn(
    process.execPath,
    [
      serverScript,
      "--root",
      root,
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--runtime-host",
      "127.0.0.1",
      "--runtime-port",
      String(runtimePort)
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });

  await waitForListening(child);
  const response = await upgrade(webPort);

  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.deepEqual(observed, {
    url: "/ws?dashboard=true",
    host: `127.0.0.1:${runtimePort}`
  });
});

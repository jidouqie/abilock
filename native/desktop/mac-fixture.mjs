import http from "node:http";
import fs from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";

const directory = "/private/tmp/abilock-desktop-mac-fixture";
if (await fs.readFile(`${directory}/abilock-build.marker`, "utf8") !== "Abilock desktop fixture")
  throw new Error("Invalid fixture marker");
const page = "<!doctype html><html><head><meta charset='utf-8'><title>Abilock test</title></head><body style='font:18px system-ui;padding:32px'><h1>Abilock synthetic configuration</h1><p>No credentials or real connection data.</p><p>This window closes automatically after 20 seconds.</p><label>Test file <input type='file'></label><button onclick='confirm(\"Synthetic confirmation\")'>Test confirmation</button></body></html>";
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(page) });
  response.end(page);
});
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await fs.writeFile(`${directory}/fixture-stopped.txt`, "stdin closed; listener stopped");
    process.stdin.destroy();
  });
  server.closeAllConnections();
};
process.stdin.once("end", close);
process.stdin.once("error", close);
process.on("SIGTERM", close);
process.stdin.resume();
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  await fs.writeFile(`${directory}/fixture-started.json`, JSON.stringify({ processId: process.pid, port }));
  process.stdout.write(JSON.stringify({ type: "configuration-ready", url: `http://127.0.0.1:${port}` }) + "\n");
});

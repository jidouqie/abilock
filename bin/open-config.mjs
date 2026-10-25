import { spawn } from "node:child_process";

// Only a public address is accepted. Authentication is entered in the UI.
export function managementUrl(value = "http://127.0.0.1:4317") {
  if (
    typeof value !== "string" ||
    /[\s\\?#@]/.test(value) ||
    !/^https?:\/\/[^/]+\/?$/i.test(value)
  )
    throw new Error("管理地址需为无认证信息的 loopback HTTP 或 HTTPS 根地址");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("管理地址需为无认证信息的 loopback HTTP 或 HTTPS 根地址");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error("管理地址需为无认证信息的 loopback HTTP 或 HTTPS 根地址");
  return url.href;
}

export function browserCommand(url, platform = process.platform) {
  // Pass the URL as an argument; never interpolate it into a shell command.
  const safeUrl = managementUrl(url);
  if (platform === "darwin")
    return { command: "open", args: ["-a", "Google Chrome", safeUrl] };
  if (platform === "win32")
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", safeUrl],
    };
  if (platform === "linux") return { command: "xdg-open", args: [safeUrl] };
  throw new Error("当前系统不支持自动打开管理页面");
}

function cancelled() {
  return Object.assign(new Error("浏览器打开已取消"), { name: "AbortError" });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ signal?: AbortSignal }} [options]
 */
async function launchBrowser(command, args, { signal } = {}) {
  if (signal?.aborted) throw cancelled();
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore" });
    let settled = false;
    let force;
    const terminate = () => {
      child.kill();
      if (force === undefined) {
        force = setTimeout(() => child.kill("SIGKILL"), 1500);
        force.unref();
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      terminate();
      finish(cancelled());
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new Error("浏览器打开超时"));
    }, 10000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", () => {
      clearTimeout(force);
      finish(new Error("浏览器打开失败"));
    });
    child.once("close", (code) => {
      clearTimeout(force);
      if (code === 0) finish();
      else finish(new Error("浏览器打开失败"));
    });
  });
}

/**
 * @param {string} value
 * @param {{ platform?: NodeJS.Platform, launch?: typeof launchBrowser, signal?: AbortSignal }} [options]
 */
export async function openConfigPage(
  value,
  { platform = process.platform, launch = launchBrowser, signal } = {},
) {
  if (signal?.aborted) throw cancelled();
  const url = managementUrl(value);
  const { command, args } = browserCommand(url, platform);
  await launch(command, args, { signal });
  return url;
}

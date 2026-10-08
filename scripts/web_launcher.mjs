import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file, fallback) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
const locator = path.join(root, ".runtime/web-profile.json"),
  runtimeFile = path.join(root, ".runtime/web-runtime.json");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
let selected =
    process.env.WORKBENCH_PROFILE ||
    read(locator, {}).root ||
    path.join(root, "profile"),
  child,
  instance,
  stopping = false,
  crashed = false;
const buildFile = path.join(root, ".runtime/server/main.mjs");
if (
  !fs.existsSync(buildFile) ||
  !fs.existsSync(path.join(root, ".runtime/web-ui/index.html"))
)
  throw Error("请先运行 npm run build:web 构建应用。");
function waitExit(process) {
  return new Promise((resolve) => {
    if (process.exitCode !== null) return resolve();
    process.once("exit", resolve);
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const owned = child;
  owned.stdin.on("error", () => {});
  owned.stdin.end(JSON.stringify({ command: "shutdown", instance }) + "\n");
  await waitExit(owned);
}
async function maintenance(action, target) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [
        buildFile,
        "--profile-maintenance",
        action,
        "--source",
        selected,
        "--target",
        target || selected,
        "--locator",
        locator,
      ],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    process.stdout.on("data", (c) => (output += c));
    process.stderr.resume();
    process.once("error", reject);
    process.once("exit", (code) =>
      code === 0
        ? resolve(JSON.parse(output))
        : reject(Error("资料维护失败；原定位与资料保留")),
    );
  });
}
async function start() {
  instance = randomBytes(24).toString("hex");
  child = spawn(process.execPath, [buildFile], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WORKBENCH_APP_ROOT: root,
      WORKBENCH_WEB_ASSETS: path.join(root, ".runtime/web-ui"),
      WORKBENCH_PROFILE: selected,
      WORKBENCH_MANAGED_WEB: "1",
      WORKBENCH_INSTANCE: instance,
      WORKBENCH_PARENT_PID: String(process.pid),
    },
  });
  const owned = child,
    lines = readline.createInterface({ input: owned.stdout });
  owned.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(Error("后台启动超时")), 45000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      owned.stdout.resume();
      error ? reject(error) : resolve(value);
    };
    owned.once("error", (error) => finish(error));
    owned.once("exit", () =>
      finish(Error("后台启动失败；检查端口、资料位置和正在运行的实例")),
    );
    lines.on("line", async (line) => {
      try {
        const msg = JSON.parse(line);
        if (
          msg.pid !== owned.pid ||
          msg.version !== version ||
          msg.instance !== instance ||
          !msg.serviceId
        )
          return;
        const response = await fetch(msg.origin + "/api/runtime", {
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          }),
          actual = await response.json();
        if (
          !response.ok ||
          actual.serviceId !== msg.serviceId ||
          actual.pid !== owned.pid ||
          actual.instance !== instance ||
          actual.version !== version ||
          actual.backend !== "node-typescript"
        )
          throw Error("后台身份核验失败");
        finish(null, msg);
      } catch (error) {
        if (line.startsWith("{")) finish(error);
      }
    });
  });
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({
      ...ready,
      profileRoot: selected,
      launcherPid: process.pid,
    }),
  );
  console.log("灵犀工作坊 " + version + " 已启动：" + ready.origin + "/");
  console.log(
    "Profile：" + selected + "\n请保留当前窗口，按 Ctrl+C 正常退出。",
  );
  const host =
    process.env.WORKBENCH_HOST ||
    read(path.join(selected, "config/web-server.json"), {}).host ||
    "127.0.0.1";
  if (host === "0.0.0.0")
    for (const entries of Object.values(os.networkInterfaces()))
      for (const address of entries || [])
        if (address.family === "IPv4" && !address.internal)
          console.log(
            "局域网：http://" +
              address.address +
              ":" +
              ready.port +
              "/ （凭证见设置）",
          );
  if (process.argv.includes("--open-browser"))
    spawn(
      process.platform === "win32"
        ? "explorer.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open",
      [ready.origin + "/"],
      { windowsHide: true, stdio: "ignore" },
    ).on("error", () => {});
  owned.once("exit", () => {
    if (!stopping) {
      crashed = true;
      console.error("后台已退出，请重新启动。");
      process.exitCode = 1;
    }
  });
  return owned;
}
try {
  await start();
  const requests = setInterval(async () => {
    if (crashed) {
      clearInterval(requests);
      return;
    }
    if (stopping) return;
    const file = path.join(selected, "data/.maintenance-request.json"),
      request = read(file, {});
    if (request.status !== "queued") return;
    stopping = true;
    try {
      await stop();
      await maintenance(request.action, request.target);
      if (request.action === "migrate") selected = request.target;
      fs.rmSync(file, { force: true });
      await start();
      fs.writeFileSync(
        path.join(selected, "data/.maintenance-request.json"),
        JSON.stringify({
          ...request,
          status: "complete",
          finished: Date.now() / 1000,
        }),
      );
    } catch (error) {
      console.error(error.message);
      fs.writeFileSync(
        file,
        JSON.stringify({ ...request, status: "failed", error: error.message }),
      );
      if (!child || child.exitCode !== null)
        await start().catch((e) => console.error(e.message));
    } finally {
      stopping = false;
    }
  }, 500);
  let exiting = false;
  const exit = async () => {
    if (exiting) return;
    exiting = true;
    clearInterval(requests);
    stopping = true;
    await stop();
    const saved = read(runtimeFile, {});
    if (saved.launcherPid === process.pid)
      fs.rmSync(runtimeFile, { force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => exit());
} catch (error) {
  console.error(error.message);
  if (child && child.exitCode === null) await stop();
  process.exitCode = 1;
}

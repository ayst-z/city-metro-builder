#!/usr/bin/env node
/**
 * 一键回归入口：顺序运行 _dev 下 7 组既有测试，逐项输出 PASS/FAIL，最后汇总；
 * 任一测试失败、超时或无法启动时以非 0 退出码结束（不会吞错误）。
 *
 * 用法（在任意目录均可）：
 *   node _dev/run-all.mjs
 *   node _dev/run-all.mjs --timeout 300000     # 单组超时 ms
 *   node _dev/run-all.mjs --help
 *
 * 环境变量：
 *   RUN_ALL_TIMEOUT_MS  单组超时（默认 180000）
 *   RUN_ALL_PYTHON      指定 Python 可执行文件（默认探测 python / python3 / py -3）
 *
 * 实现约束：
 *   - 子进程使用 spawn(argv 数组, shell:false)，不经过 shell 拼接，避免注入；
 *   - 子进程 stdout/stderr 实时转发，失败时保留完整输出，不做二次过滤；
 *   - 工作目录固定为技能根目录，脚本用绝对路径定位，兼容本工作区与装机副本；
 *   - --help / 参数错误路径不探测 Python，帮助打印即返回；
 *   - Windows 超时先 taskkill /T /F；taskkill 退出但非 0（或未能终止）时用 TerminateProcess
 *     兜底并复检，仍存活则告警，避免把“杀失败”当成功；
 *   - POSIX 超时/中断按进程组 SIGTERM → 宽限 → SIGKILL，组不存在时退化为直接 kill；
 *   - 超时后 close 迟迟不到时销毁 stdio 句柄并 unref 子进程，保证 runner 不悬挂；
 *   - SIGINT / SIGTERM（Windows 另含 SIGBREAK）终止当前测试树、跳过后续组，退出码 130。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 180000;

let activeChild = null;
let interrupted = false;
let signalCount = 0;

/** 解析 --timeout / --help（位置参数忽略） */
function parseArgs(argv) {
  const opts = { timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  const envTimeout = Number(process.env.RUN_ALL_TIMEOUT_MS);
  if (Number.isFinite(envTimeout) && envTimeout > 0) opts.timeoutMs = envTimeout;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("--timeout 需要正整数毫秒，收到：" + String(raw));
      opts.timeoutMs = ms;
    } else if (arg.startsWith("-")) {
      throw new Error("未知参数：" + arg + "（仅支持 --timeout <ms> 与 --help）");
    }
  }
  return opts;
}

/** 探测 Python：RUN_ALL_PYTHON 优先，其次 python / python3 / py -3（--help 路径不调用） */
function detectPython() {
  const candidates = [];
  if (process.env.RUN_ALL_PYTHON) candidates.push({ cmd: process.env.RUN_ALL_PYTHON, prefix: [] });
  candidates.push({ cmd: "python", prefix: [] }, { cmd: "python3", prefix: [] }, { cmd: "py", prefix: ["-3"] });
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.cmd, [...candidate.prefix, "--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/** 7 组的静态定义（帮助只依赖这里，不触发 Python 探测） */
const GROUP_SPECS = [
  { id: "lint-static", title: "静态一致性", script: "_dev/lint-static.js", kind: "node" },
  { id: "smoke", title: "VM 冒烟 + API/版本", script: "_dev/smoke.js", kind: "node" },
  { id: "test-plan-map", title: "规划图配准/追线（Python）", script: "_dev/test-plan-map.py", kind: "python" },
  { id: "test-plan-poi", title: "POI 归属/降级（17 项）", script: "_dev/test-plan-poi.js", kind: "node" },
  { id: "test-plan-draw", title: "规划图绘制/四检（45 项）", script: "_dev/test-plan-draw.js", kind: "node-test" },
  { id: "test-autopilot", title: "经营托管/回滚（12 项）", script: "_dev/test-autopilot.js", kind: "node" },
  { id: "test-branch-ring", title: "支线/环线（3 项）", script: "_dev/test-branch-ring.js", kind: "node" },
];

/** 把静态定义解析为可执行命令（Python 组使用探测结果/缺省 python） */
function resolveGroup(spec, python) {
  if (spec.kind === "python") {
    return {
      ...spec,
      cmd: python ? python.cmd : "python",
      args: (p) => [...(python ? python.prefix : []), p],
    };
  }
  if (spec.kind === "node-test") return { ...spec, cmd: NODE, args: (p) => ["--test", p] };
  return { ...spec, cmd: NODE, args: (p) => [p] };
}

function fmtSeconds(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程是否仍存活（signal 0 探测；EPERM 视为存活） */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

/** 等待子进程退出/消失；返回是否已退出 */
async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !isProcessAlive(child.pid)) return true;
    await delay(50);
  }
  return child.exitCode !== null || !isProcessAlive(child.pid);
}

/** 释放子进程句柄，避免幸存子进程的 stdio 让 runner 悬挂 */
function releaseChildHandles(child) {
  if (!child) return;
  try { child.stdout.destroy(); } catch { /* 已关闭 */ }
  try { child.stderr.destroy(); } catch { /* 已关闭 */ }
  try { child.unref(); } catch { /* 已退出 */ }
}

/**
 * 结束子进程树（异步）：
 *   Windows：taskkill /T /F；taskkill 非 0 或未能终止时 TerminateProcess 兜底并复检；
 *   POSIX：进程组 SIGTERM → 宽限 1s → SIGKILL，组不存在时退化为直接 kill。
 * 返回 { method, alive }，alive=true 表示复检后仍存活（如实告警，不假装成功）。
 */
async function terminateTree(child) {
  if (!child || !child.pid) return { method: "none", alive: false };
  if (child.exitCode !== null) return { method: "already-exited", alive: false };

  if (IS_WINDOWS) {
    let method = "taskkill";
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const taskkillOk = !result.error && result.status === 0;
    if (taskkillOk && (await waitForExit(child, 500))) {
      return { method, alive: false };
    }
    // taskkill 非 0 且进程已消失：属于“竞态已退出”，不是杀失败
    if (!taskkillOk && (child.exitCode !== null || !isProcessAlive(child.pid))) {
      return { method: "already-exited", alive: false };
    }
    const reason = result.error ? result.error.message : "exit=" + result.status;
    console.error("[warn] taskkill 未能结束进程树（" + reason + "），改用 TerminateProcess 兜底");
    method += "+terminate";
    try { child.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
    if (!(await waitForExit(child, 1000))) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/F"], { stdio: "ignore", windowsHide: true });
      method += "+taskkill-f";
      await waitForExit(child, 1000);
    }
    return { method, alive: child.exitCode === null && isProcessAlive(child.pid) };
  }

  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return Boolean(error && error.code === "EPERM");
    }
  };
  let method = "group-sigterm";
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    method = "child-sigterm";
    try { child.kill("SIGTERM"); } catch { /* 进程可能已退出 */ }
  }
  // 等组长退出或整个进程组消失；组内成员可能忽略 SIGTERM，超时后整组 SIGKILL
  const graceUntil = Date.now() + 1000;
  while (Date.now() < graceUntil && (child.exitCode === null || groupAlive())) await delay(50);
  if (child.exitCode !== null && !groupAlive()) return { method, alive: false };
  method += "+group-sigkill";
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
  }
  const killUntil = Date.now() + 1000;
  while (Date.now() < killUntil && (child.exitCode === null || groupAlive())) await delay(50);
  return { method, alive: (child.exitCode === null && isProcessAlive(child.pid)) || groupAlive() };
}

/** 运行一组测试；返回 { pass, code, signal, timedOut, spawnError, ms, stdout, stderr } */
function runGroup(group, timeoutMs) {
  const scriptPath = path.join(ROOT, group.script);
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({
      pass: false, code: null, signal: null, timedOut: false, ms: 0, stdout: "", stderr: "",
      spawnError: new Error("测试文件不存在：" + group.script),
    });
  }
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(group.cmd, group.args(scriptPath), {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        detached: !IS_WINDOWS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ pass: false, code: null, signal: null, timedOut: false, ms: Date.now() - started, stdout: "", stderr: "", spawnError: error });
      return;
    }
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateTree(child).then((info) => {
        if (settled) return;
        if (info.alive) {
          console.error("[warn] " + group.id + " 超时终止后进程仍存活（pid " + child.pid + "）");
        }
        forceTimer = setTimeout(() => {
          if (settled) return;
          console.error("[warn] " + group.id + " 超时后 close 未到达，强制释放子进程句柄");
          releaseChildHandles(child);
          settle(null, "SIGKILL", null);
        }, 3000);
        forceTimer.unref();
      }).catch((error) => {
        if (settled) return;
        console.error("[warn] " + group.id + " 终止进程树异常：" + (error && error.message ? error.message : String(error)));
        releaseChildHandles(child);
        settle(null, "SIGKILL", null);
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    const settle = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut || interrupted) releaseChildHandles(child);
      if (activeChild === child) activeChild = null;
      const pass = !spawnError && !timedOut && !interrupted && code === 0 && !signal;
      resolve({ pass, code, signal, timedOut, ms: Date.now() - started, stdout, stderr, spawnError });
    };
    child.on("error", (error) => settle(null, null, error));
    child.on("close", (code, signal) => settle(code, signal, null));
  });
}

/** 中断：终止当前进程树、跳过后续组，退出码 130 */
function installSignalHandlers() {
  const signals = ["SIGINT", "SIGTERM"];
  if (IS_WINDOWS) signals.push("SIGBREAK");
  for (const signal of signals) {
    process.on(signal, () => {
      signalCount += 1;
      if (signalCount > 1) {
        console.error("\n收到第二次 " + signal + "，强制退出（退出码 130）");
        if (activeChild) releaseChildHandles(activeChild);
        process.exit(130);
      }
      interrupted = true;
      console.error("\n收到 " + signal + "：终止当前测试并停止后续组（退出码 130）");
      const target = activeChild;
      if (target) {
        void terminateTree(target).then((info) => {
          if (info.alive) console.error("[warn] 当前测试进程仍存活（pid " + target.pid + "）");
        }).catch((error) => {
          console.error("[warn] 终止当前测试进程树异常：" + (error && error.message ? error.message : String(error)));
        });
      }
      const force = setTimeout(() => {
        if (activeChild) releaseChildHandles(activeChild);
        process.exit(130);
      }, 3000);
      force.unref();
    });
  }
}

function printHelp() {
  console.log("用法：node _dev/run-all.mjs [--timeout <ms>] [--help]\n");
  console.log("顺序运行 7 组离线回归，逐项 PASS/FAIL 并汇总；任一组失败/超时/无法启动时退出码非 0。\n");
  console.log("选项：");
  console.log("  --timeout <ms>  单组超时，默认 180000（亦可用 RUN_ALL_TIMEOUT_MS）");
  console.log("  --help, -h      显示本帮助\n");
  console.log("环境变量：");
  console.log("  RUN_ALL_PYTHON  指定 Python 可执行文件（默认探测 python / python3 / py -3）\n");
  console.log("测试组（顺序）：");
  GROUP_SPECS.forEach((g, i) => console.log("  " + (i + 1) + ". " + g.id.padEnd(18) + " " + g.title));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error("参数错误：" + error.message);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }

  // 帮助与参数错误路径不探测 Python；只有真正要跑测试时才探测
  const python = detectPython();
  const groups = GROUP_SPECS.map((spec) => resolveGroup(spec, python));
  if (!python) {
    console.warn("警告：未探测到 Python（python / python3 / py -3），test-plan-map 将失败；可用 RUN_ALL_PYTHON 指定。");
  }

  installSignalHandlers();

  console.log("== city-metro-builder 离线回归 ==");
  console.log("技能根目录：" + ROOT);
  console.log("Node：" + NODE + " · Python：" + (python ? python.cmd + (python.prefix.length ? " " + python.prefix.join(" ") : "") : "未找到"));
  console.log("单组超时：" + opts.timeoutMs + "ms · 共 " + groups.length + " 组（顺序执行）\n");

  const results = [];
  const allStarted = Date.now();
  for (let i = 0; i < groups.length; i += 1) {
    if (interrupted) break;
    const group = groups[i];
    const tag = "[" + (i + 1) + "/" + groups.length + "]";
    console.log(tag + " " + group.id + " · " + group.title);
    console.log(tag + " $ " + [group.cmd, ...group.args(path.join(ROOT, group.script))].join(" "));
    const result = await runGroup(group, opts.timeoutMs);
    results.push({ group, result });
    const verdict = result.pass ? "PASS" : "FAIL";
    let detail = fmtSeconds(result.ms);
    if (result.timedOut) detail += " · 超时（>" + opts.timeoutMs + "ms）";
    else if (result.spawnError) detail += " · 启动失败：" + result.spawnError.message;
    else if (!result.pass) detail += " · exit=" + (result.code === null ? "null" : result.code) + (result.signal ? " signal=" + result.signal : "");
    console.log(tag + " " + verdict + " " + group.id + "（" + detail + "）\n");
    if (interrupted) break;
  }
  const totalMs = Date.now() - allStarted;

  if (interrupted) {
    console.error("中断：已完成 " + results.length + "/" + groups.length + " 组，剩余未运行（退出码 130）");
    process.exitCode = 130;
    return;
  }

  const failed = results.filter(({ result }) => !result.pass);
  console.log("============================================================");
  console.log("结果汇总");
  for (const { group, result } of results) {
    const line = (result.pass ? "PASS" : "FAIL").padEnd(4) + "  " + group.id.padEnd(18) + " " + fmtSeconds(result.ms).padStart(7);
    console.log("  " + line + (result.pass ? "" : "  ← " + (result.timedOut ? "超时" : result.spawnError ? "启动失败" : "exit=" + result.code)));
  }
  console.log("============================================================");
  console.log("总计：" + (results.length - failed.length) + "/" + results.length + " 通过 · " + failed.length + " 失败 · 用时 " + fmtSeconds(totalMs));
  if (failed.length) {
    console.error("FAIL：以下测试未通过（完整输出见上方逐项日志）");
    for (const { group, result } of failed) {
      console.error("- " + group.id + "（" + group.script + "）：" +
        (result.timedOut ? "超时" : result.spawnError ? result.spawnError.message : "exit=" + result.code + (result.signal ? " signal=" + result.signal : "")));
    }
    process.exitCode = 1;
    return;
  }
  console.log("全部通过（" + results.length + "/" + results.length + "）");
}

main().catch((error) => {
  console.error("run-all 异常：" + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const CQ_HOME = path.resolve(process.env.CQ_HOME || path.join(os.homedir(), ".cq"));
const QUEUE_FILE = path.join(CQ_HOME, "queue.json");
const DAEMON_PID_FILE = path.join(CQ_HOME, "daemon.pid");
const DAEMON_LOG_FILE = path.join(CQ_HOME, "daemon.log");
const DAEMON_META_FILE = path.join(CQ_HOME, "daemon.meta.json");
const SELF_FILE = fileURLToPath(import.meta.url);
const SOURCE_VERSION = sourceVersion();
const QUOTA_CONTINUATION_PROMPT =
  "Continue the unfinished work from the previous turn. Complete the original request and verify the result.";

fs.mkdirSync(CQ_HOME, { recursive: true });

function sourceVersion() {
  const stat = fs.statSync(SELF_FILE);
  return `${stat.size}:${stat.mtimeMs}`;
}

function sourceWasUpdated() {
  try {
    return sourceVersion() !== SOURCE_VERSION;
  } catch {
    return false;
  }
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  const tmp = QUEUE_FILE + ".tmp";

  fs.writeFileSync(
    tmp,
    JSON.stringify(queue, null, 2),
    "utf8"
  );

  fs.renameSync(tmp, QUEUE_FILE);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function newId() {
  return Date.now().toString(36);
}

function formatDate(ts) {
  if (!ts) return "-";

  return new Date(ts).toLocaleString();
}

function findCodex() {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "where.exe",
        ["codex"],
        { encoding: "utf8" }
      );

      const paths = output
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

      const executable =
        paths.find(p => /\.(exe|cmd|bat)$/i.test(p)) ||
        paths[0];

      if (!executable) {
        throw new Error();
      }

      return executable;
    }

    return "codex";
  } catch {
    console.error("Codex CLI was not found.");
    console.error("Verify the installation with: codex --version");
    process.exit(1);
  }
}

function isQuotaError(text) {
  return /usage limit|rate limit|rate_limit_exceeded|quota exceeded|quota limit|try again in|try again at/i.test(
    text
  );
}

/**
 * Parses messages such as:
 *
 * try again in 2h 15m
 * try again in 45 minutes
 * resets in 1 hour
 * try again at 11:30 PM
 */
function parseRetryAt(text, now = Date.now()) {

  // Relative time
  const relative = text.match(
    /(?:try again|reset(?:s)?|available again)[^\r\n]{0,40}?\bin\s+(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?\s*(?:(\d+)\s*(?:s|sec|secs|second|seconds))?/i
  );

  if (relative && (relative[1] || relative[2] || relative[3])) {
    const hours = Number(relative[1] || 0);
    const minutes = Number(relative[2] || 0);
    const seconds = Number(relative[3] || 0);

    return (
      now +
      hours * 3600000 +
      minutes * 60000 +
      seconds * 1000 +
      30000
    );
  }

  // Absolute 12-hour time
  const absolute12 = text.match(
    /(?:try again|reset(?:s)?|available again)[^\r\n]{0,50}?\bat\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i
  );

  if (absolute12) {
    let hour = Number(absolute12[1]);
    const minute = Number(absolute12[2]);
    const ap = absolute12[3].toUpperCase();

    if (ap === "PM" && hour !== 12) {
      hour += 12;
    }

    if (ap === "AM" && hour === 12) {
      hour = 0;
    }

    const target = new Date(now);

    target.setHours(hour, minute, 30, 0);

    if (target.getTime() <= now) {
      if (now - target.getTime() < 5 * 60 * 1000) {
        return now + 30000;
      }

      target.setDate(target.getDate() + 1);
    }

    return target.getTime();
  }

  // Absolute 24-hour time
  const absolute24 = text.match(
    /(?:try again|reset(?:s)?|available again)[^\r\n]{0,50}?\bat\s+(\d{1,2}):(\d{2})/i
  );

  if (absolute24) {
    const target = new Date(now);

    target.setHours(
      Number(absolute24[1]),
      Number(absolute24[2]),
      30,
      0
    );

    if (target.getTime() <= now) {
      if (now - target.getTime() < 5 * 60 * 1000) {
        return now + 30000;
      }

      target.setDate(target.getDate() + 1);
    }

    return target.getTime();
  }

  return null;
}

function parseArgs(args) {
  if (args[0]?.startsWith("“")) {
    throw new Error('Use straight quotes: cq add "task" --session SESSION_ID');
  }

  let cwd = process.cwd();
  let threadId = null;
  let last = false;
  let approval = "auto";
  const promptParts = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") {
      cwd = args[++i];

      if (!cwd || cwd.startsWith("--")) {
        throw new Error("--cwd requires a value");
      }

      continue;
    }

    if (args[i] === "--session") {
      threadId = args[++i];

      if (!threadId || threadId.startsWith("--")) {
        throw new Error("--session requires a value");
      }

      continue;
    }

    if (args[i] === "--last") {
      last = true;
      continue;
    }

    if (args[i] === "--approval") {
      approval = parseApproval(args[++i]);
      continue;
    }

    promptParts.push(args[i]);
  }

  if (threadId && last) {
    throw new Error("--session and --last cannot be used together");
  }

  if (approval === "ask" && !threadId) {
    throw new Error("--approval ask requires --session because exec is non-interactive");
  }

  if (!threadId && /(?:^|\s)--session(?:\s|$)/.test(promptParts.join(" "))) {
    throw new Error('--session was parsed as task text; use straight quotes around only the task');
  }

  return {
    prompt: promptParts.join(" ").trim(),
    cwd: path.resolve(cwd),
    threadId,
    last,
    approval
  };
}

function parseApproval(value) {
  if (!["ask", "auto", "all"].includes(value)) {
    throw new Error("--approval must be ask, auto, or all");
  }

  return value;
}

function approvalArgs(mode = "auto") {
  if (mode === "ask") return ["-a", "on-request"];
  if (mode === "all") return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["--approve-for-me"];
}

function processIsAlive(pid) {
  if (!pid) return false;

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function isSessionBusyError(text) {
  return /thread-store conflict|already has an active writer/i.test(text);
}

function deferQueueForQuota(queue, retryAt) {
  for (const task of queue) {
    if (
      task.status === "queued" ||
      task.status === "waiting_quota"
    ) {
      task.status = "waiting_quota";
      task.runAfter = retryAt;
      task.lastError = "quota";
    }
  }
}

function pauseForSession(task) {
  task.status = "paused_session";
  task.runAfter = null;
  task.lastError = "session is active in another Codex process";
  clearWorker(task);
}

function retryable(task) {
  return ["failed", "paused_session", "waiting_session"].includes(task.status);
}

function requeue(task) {
  task.status = "queued";
  task.runAfter = null;
  task.lastError = null;
  clearWorker(task);
}

function completeTask(task) {
  task.status = "done";
  task.completedAt = Date.now();
  task.runAfter = null;
  task.lastError = null;
  task.nextPrompt = null;
  clearWorker(task);
}

function waitForQuota(task, retryAt) {
  task.status = "waiting_quota";
  task.runAfter = retryAt;
  task.lastError = "quota";

  if (task.threadId) {
    task.nextPrompt = QUOTA_CONTINUATION_PROMPT;
  }

  clearWorker(task);
}

function clearWorker(task) {
  delete task.workerToken;
  delete task.workerPid;
  delete task.dispatchedAt;
}

function daemonPid() {
  try {
    const pid = Number(fs.readFileSync(DAEMON_PID_FILE, "utf8"));

    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function daemonUsesCurrentSource(pid) {
  try {
    const meta = JSON.parse(fs.readFileSync(DAEMON_META_FILE, "utf8"));
    return meta.pid === pid && meta.sourceVersion === SOURCE_VERSION;
  } catch {
    return false;
  }
}

function ensureDaemon() {
  const runningPid = daemonPid();

  if (runningPid) return runningPid;

  const log = fs.openSync(DAEMON_LOG_FILE, "a");
  const child = spawn(process.execPath, [process.argv[1], "daemon"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log]
  });
  fs.closeSync(log);

  child.on("error", error => {
    fs.rmSync(DAEMON_PID_FILE, { force: true });
    console.error(`Failed to start daemon: ${error.message}`);
  });

  if (child.pid) {
    fs.writeFileSync(DAEMON_PID_FILE, String(child.pid));
  }

  child.unref();
  return child.pid;
}

function executableOnPath(name, env = process.env) {
  if (!name) return null;

  if (path.isAbsolute(name)) {
    return fs.existsSync(name) ? name : null;
  }

  const extensions = path.extname(name)
    ? [""]
    : process.platform === "win32"
      ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;

    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }

  return null;
}

function linuxTerminalSpec(workerCommand, env = process.env) {
  const requested = env.TERMINAL;
  const candidates = [
    requested,
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "kitty",
    "alacritty",
    "xterm"
  ].filter(Boolean);

  for (const candidate of candidates) {
    const executable = executableOnPath(candidate, env);
    if (!executable) continue;

    const name = path.basename(executable).toLowerCase();
    const title = workerCommand.title;

    if (name.includes("gnome-terminal")) {
      return {
        command: executable,
        args: ["--title", title, "--", ...workerCommand.args]
      };
    }

    if (name.includes("konsole")) {
      return {
        command: executable,
        args: ["-p", `tabtitle=${title}`, "-e", ...workerCommand.args]
      };
    }

    if (name.includes("kitty")) {
      return {
        command: executable,
        args: ["--title", title, ...workerCommand.args]
      };
    }

    if (name.includes("alacritty")) {
      return {
        command: executable,
        args: ["--title", title, "-e", ...workerCommand.args]
      };
    }

    return {
      command: executable,
      args: ["-T", title, "-e", ...workerCommand.args]
    };
  }

  return null;
}

function workerCommand(taskId, workerToken) {
  return {
    title: `CQ Task ${taskId}`,
    args: [process.execPath, SELF_FILE, "__worker", taskId, workerToken]
  };
}

function startDetached(command, args, options = {}) {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      windowsHide: false,
      stdio: "ignore",
      ...options
    });

    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value) child.unref();
      resolve(value);
    };

    const timer = setTimeout(() => finish(child.pid || null), 500);
    child.once("spawn", () => finish(child.pid || null));
    child.once("error", () => finish(null));
  });
}

async function launchVisibleWorker(taskId, workerToken, cwd) {
  const worker = workerCommand(taskId, workerToken);

  if (process.platform === "win32") {
    const command = worker.args
      .map(value => `"${String(value).replaceAll('"', '\\"')}"`)
      .join(" ");

    const windowsTerminal = executableOnPath("wt.exe");

    if (windowsTerminal) {
      const launched = await startDetached(
        windowsTerminal,
        [
          "-w",
          "-1",
          "new-tab",
          "--title",
          worker.title,
          "--suppressApplicationTitle",
          process.env.ComSpec || "cmd.exe",
          "/d",
          "/s",
          "/c",
          command
        ],
        { cwd }
      );

      if (launched) return true;
    }

    const launched = await startDetached(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", `start "${worker.title}" ${command}`],
      { cwd }
    );

    if (launched) return true;
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    const terminal = linuxTerminalSpec(worker);

    if (terminal) {
      const launched = await startDetached(
        terminal.command,
        terminal.args,
        { cwd }
      );

      if (launched) return true;
    }
  }

  const log = fs.openSync(DAEMON_LOG_FILE, "a");
  const child = spawn(worker.args[0], worker.args.slice(1), {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log]
  });
  fs.closeSync(log);
  child.unref();
  return Boolean(child.pid);
}

function spawnCodex(codexPath, args, cwd) {
  // A global npm installation may expose codex.cmd on Windows.
  if (
    process.platform === "win32" &&
    /\.(cmd|bat)$/i.test(codexPath)
  ) {
    const quote = value =>
      `"${String(value).replaceAll('"', '\\"')}"`;

    const command = [
      quote(codexPath),
      ...args.map(quote)
    ].join(" ");

    return spawn(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
  }

  return spawn(codexPath, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function quotaRetryAtFromSnapshot(snapshot, now = Date.now()) {
  const limits = snapshot?.rateLimitsByLimitId?.codex || snapshot?.rateLimits;

  if (!limits) return null;

  const exhausted = [limits.primary, limits.secondary]
    .filter(window => window?.usedPercent >= 100 && window.resetsAt)
    .map(window => window.resetsAt * 1000 + 30000);

  return exhausted.length ? Math.max(now + 30000, ...exhausted) : now + 30000;
}

function readQuotaRetryAt(cwd = process.cwd()) {
  return new Promise(resolve => {
    const child = spawnCodex(findCodex(), ["app-server", "--stdio"], cwd);
    let buffer = "";
    let settled = false;

    const finish = retryAt => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(retryAt);
    };

    const timer = setTimeout(() => finish(null), 10000);

    child.stdout.on("data", chunk => {
      buffer += chunk.toString();

      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        try {
          const message = JSON.parse(line);

          if (message.id === 1 && message.result) {
            child.stdin.write('{"method":"initialized","params":{}}\n');
            child.stdin.write('{"id":2,"method":"account/rateLimits/read","params":null}\n');
          } else if (message.id === 2) {
            finish(quotaRetryAtFromSnapshot(message.result));
          }
        } catch {
          // Ignore non-JSON output.
        }
      }
    });

    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => {});
    child.stdin.write('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"cq","version":"1"},"capabilities":{"experimentalApi":true}}}\n');
  });
}

function codexInvocation(task) {
  const approval = task.approval || "auto";
  const approvalOptions = approvalArgs(approval);
  const prompt = task.nextPrompt || task.prompt;

  if (task.threadId) {
    return {
      args: [
        ...approvalOptions,
        "exec",
        "resume",
        task.threadId,
        "--json",
        "--skip-git-repo-check",
        "-"
      ],
      prompt
    };
  }

  if (task.last) {
    return {
      args: [
        ...approvalOptions,
        "exec",
        "resume",
        "--last",
        "--json",
        "--skip-git-repo-check",
        "-"
      ],
      prompt,
    };
  }

  return {
    args: [
      ...approvalOptions,
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...(approval === "all" ? [] : ["--sandbox", "workspace-write"]),
      "-"
    ],
    prompt,
  };
}

function runCodex(task) {
  return new Promise(resolve => {
    const codexPath = findCodex();
    const { args, prompt } = codexInvocation(task);

    if (task.threadId) {
      console.log(`\nResuming Codex session: ${task.threadId}`);
    } else if (task.last) {
      console.log("\nResuming the latest Codex session");
    } else {
      console.log("\nStarting a new Codex session");
    }

    console.log(`Directory: ${task.cwd}`);
    console.log(`Task: ${task.prompt}`);

    if (task.nextPrompt) {
      console.log(`Resume instruction: ${task.nextPrompt}`);
    }

    console.log("");

    const child = spawnCodex(
      codexPath,
      args,
      task.cwd
    );

    let stdout = "";
    let stderr = "";
    let buffer = "";
    let threadId = task.threadId || null;

    child.stdout.on("data", chunk => {
      const text = chunk.toString();

      stdout += text;
      buffer += text;

      let newline;

      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer
          .slice(0, newline)
          .trim();

        buffer = buffer.slice(newline + 1);

        if (!line) continue;

        try {
          const event = JSON.parse(line);

          if (
            event.type === "thread.started" &&
            event.thread_id
          ) {
            threadId = event.thread_id;

            const queue = loadQueue();
            const current = queue.find(x => x.id === task.id);

            if (current) {
              current.threadId = threadId;
              saveQueue(queue);
            }

            console.log(
              `[session] ${threadId}`
            );
          }

          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message"
          ) {
            console.log(
              `\nCodex:\n${event.item.text}\n`
            );
          }

          if (
            event.type === "item.started" &&
            event.item?.type === "command_execution"
          ) {
            console.log(`\nCommand:\n${event.item.command}\n`);
          }

          if (event.type === "turn.started") {
            console.log("Codex turn started");
          }

          if (event.type === "turn.completed") {
            console.log("Codex turn completed");
          }
        } catch {
          // Ignore non-JSON output.
        }
      }
    });

    child.stderr.on("data", chunk => {
      const text = chunk.toString();

      stderr += text;

      process.stderr.write(text);
    });

    child.on("error", error => {
      resolve({
        code: -1,
        output: stdout + "\n" + stderr + "\n" + error.message,
        threadId
      });
    });

    child.on("close", code => {
      resolve({
        code,
        output: stdout + "\n" + stderr,
        threadId
      });
    });

    child.stdin.on("error", () => {});
    if (prompt) child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runOneTask(taskId = null, workerToken = null) {
  let queue = loadQueue();

  const now = Date.now();

  const task = taskId
    ? queue.find(x => x.id === taskId)
    : queue.find(
      x =>
        (
          x.status === "queued" ||
          x.status === "waiting_quota"
        ) &&
        (!x.runAfter || x.runAfter <= now)
    );

  if (!task) {
    return false;
  }

  if (taskId) {
    if (
      task.status !== "dispatched" ||
      !workerToken ||
      task.workerToken !== workerToken
    ) {
      console.error(`Task ${taskId} is no longer assigned to this worker`);
      return false;
    }
  }

  task.status = "running";
  task.startedAt = Date.now();
  task.runAfter = null;
  task.lastError = null;

  if (workerToken) {
    task.workerPid = process.pid;
  } else {
    clearWorker(task);
  }

  saveQueue(queue);

  console.log(
    `\n========== CQ TASK ${task.id} ==========`
  );

  const result = await runCodex(task);

  // Reload so tasks added while Codex was running are preserved.
  queue = loadQueue();

  const current = queue.find(
    x => x.id === task.id
  );

  if (!current) {
    return true;
  }

  if (result.threadId) {
    current.threadId = result.threadId;
  }

  if (isQuotaError(result.output)) {
    let retryAt = await readQuotaRetryAt(current.cwd);

    if (!retryAt) {
      retryAt = parseRetryAt(result.output);
    }

    // Probe again in 10 minutes when Codex provides no reset time.
    if (!retryAt) {
      retryAt =
        Date.now() + 10 * 60 * 1000;

      console.log(
        "\nUsage limit detected, but no reset time was found."
      );

      console.log(
        "Trying again in 10 minutes."
      );
    }

    waitForQuota(current, retryAt);
    deferQueueForQuota(queue, retryAt);

    console.log(
      `\nUsage limit reached. Next attempt: ${formatDate(retryAt)}`
    );

    saveQueue(queue);

    return true;
  }

  if (isSessionBusyError(result.output)) {
    pauseForSession(current);
    saveQueue(queue);

    console.log("\nThe session is active in another Codex process. Task paused.");
    console.log(`Close that Codex task, then run: cq retry ${current.id}`);
    return true;
  }

  if (result.code === 0) {
    completeTask(current);

    console.log(
      `\nTask completed: ${current.id}`
    );
  } else {
    current.status = "failed";
    current.runAfter = null;
    current.lastError =
      `Codex exit code: ${result.code}`;
    clearWorker(current);

    console.log(
      `\nTask failed with exit code ${result.code}`
    );
  }

  saveQueue(queue);

  return true;
}

function eligibleTask(queue, now = Date.now()) {
  return queue.find(
    task =>
      (
        task.status === "queued" ||
        task.status === "waiting_quota"
      ) &&
      (!task.runAfter || task.runAfter <= now)
  );
}

async function waitForWorker(taskId, workerToken) {
  while (true) {
    const queue = loadQueue();
    const task = queue.find(item => item.id === taskId);

    if (
      !task ||
      task.workerToken !== workerToken ||
      !["dispatched", "running"].includes(task.status)
    ) {
      return;
    }

    if (
      task.status === "dispatched" &&
      Date.now() - task.dispatchedAt > 30000
    ) {
      task.status = "failed";
      task.lastError = "visible task terminal did not start";
      clearWorker(task);
      saveQueue(queue);
      return;
    }

    if (
      task.status === "running" &&
      task.workerPid &&
      !processIsAlive(task.workerPid)
    ) {
      task.status = "failed";
      task.runAfter = null;
      task.lastError = "visible task terminal closed unexpectedly";
      clearWorker(task);
      saveQueue(queue);
      return;
    }

    await sleep(1000);
  }
}

async function runNextDaemonTask() {
  let queue = loadQueue();
  const active = queue.find(
    task =>
      task.workerToken &&
      ["dispatched", "running"].includes(task.status)
  );

  if (active) {
    await waitForWorker(active.id, active.workerToken);
    return true;
  }

  const task = eligibleTask(queue);
  if (!task) return false;

  const workerToken = randomUUID();
  task.status = "dispatched";
  task.workerToken = workerToken;
  task.workerPid = null;
  task.dispatchedAt = Date.now();
  saveQueue(queue);

  const launched = await launchVisibleWorker(
    task.id,
    workerToken,
    task.cwd
  );

  if (!launched) {
    queue = loadQueue();
    const current = queue.find(item => item.id === task.id);

    if (current?.workerToken === workerToken) {
      current.status = "failed";
      current.lastError = "could not open a task terminal";
      clearWorker(current);
      saveQueue(queue);
    }

    return true;
  }

  await waitForWorker(task.id, workerToken);
  return true;
}

async function daemon() {
  const existingPid = daemonPid();

  if (existingPid && existingPid !== process.pid) {
    console.log(`Codex Queue daemon is already running (${existingPid})`);
    return;
  }

  fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));
  fs.writeFileSync(
    DAEMON_META_FILE,
    JSON.stringify({ pid: process.pid, sourceVersion: SOURCE_VERSION }),
    "utf8"
  );
  process.on("exit", () => {
    if (daemonPid() === process.pid) {
      fs.rmSync(DAEMON_PID_FILE, { force: true });
      fs.rmSync(DAEMON_META_FILE, { force: true });
    }
  });

  const queue = loadQueue();
  let recovered = 0;
  let changed = false;

  for (const task of queue) {
    if (task.status === "running") {
      if (task.workerToken && processIsAlive(task.workerPid)) {
        continue;
      }

      task.status = "queued";
      clearWorker(task);
      recovered++;
      changed = true;
    } else if (task.status === "dispatched") {
      if (
        task.workerToken &&
        (
          processIsAlive(task.workerPid) ||
          Date.now() - task.dispatchedAt <= 30000
        )
      ) {
        continue;
      }

      if (task.workerToken) {
        task.status = "queued";
        clearWorker(task);
      } else {
        pauseForSession(task);
        task.lastError = "Codex App accepted the message but did not start it";
      }

      recovered++;
      changed = true;
    } else if (task.status === "waiting_session") {
      pauseForSession(task);
      recovered++;
      changed = true;
    }
  }

  if (queue.some(task => task.status === "waiting_quota")) {
    const retryAt = await readQuotaRetryAt();

    if (retryAt) {
      deferQueueForQuota(queue, retryAt);
      changed = true;
      console.log(`Quota retry synchronized: ${formatDate(retryAt)}`);
    }
  }

  if (changed) {
    saveQueue(queue);
  }

  if (recovered) {
    console.log(`Recovered ${recovered} interrupted task(s)`);
  }

  console.log("Codex Queue daemon started");
  console.log(`Queue: ${QUEUE_FILE}`);
  console.log("Press Ctrl+C to stop\n");

  while (true) {
    try {
      const ran = await runNextDaemonTask();

      if (ran) {
        // Brief pause between tasks.
        await sleep(3000);
      } else {
        await sleep(15000);
      }

      if (sourceWasUpdated()) {
        console.log("CQ source changed; restarting the daemon before the next task");
        fs.rmSync(DAEMON_PID_FILE, { force: true });
        fs.rmSync(DAEMON_META_FILE, { force: true });
        const replacementPid = ensureDaemon();
        console.log(`Updated daemon: ${replacementPid || "failed to start"}`);
        return;
      }
    } catch (error) {
      console.error(error);
      await sleep(15000);
    }
  }
}

function listTasks() {
  const queue = loadQueue();
  let pid = daemonPid();
  let staleDaemon = Boolean(pid && !daemonUsesCurrentSource(pid));
  let replacedDaemon = false;
  const activeTask = queue.some(task =>
    ["dispatched", "running"].includes(task.status)
  );

  if (staleDaemon && !activeTask) {
    try {
      process.kill(pid);
    } catch {
      // The outdated daemon already stopped.
    }

    fs.rmSync(DAEMON_PID_FILE, { force: true });
    fs.rmSync(DAEMON_META_FILE, { force: true });
    pid = null;
    staleDaemon = false;
    replacedDaemon = true;
  }

  if (
    !pid &&
    queue.some(task =>
      ["queued", "dispatched", "running", "waiting_quota"]
        .includes(task.status)
    )
  ) {
    pid = ensureDaemon();
  }

  console.log(
    `Daemon: ${pid ? `RUNNING (${pid})${staleDaemon ? " - UPDATE PENDING" : ""}` : "STOPPED"}`
  );

  if (replacedDaemon) {
    console.log(
      pid
        ? "The idle outdated daemon was replaced with the current CQ code."
        : "The idle outdated daemon was retired; the next task will use the current CQ code."
    );
  }

  if (staleDaemon) {
    console.log("The daemon predates the installed CQ code and will not use the new terminal behavior.");
    console.log("Let the active task finish; the next cq list will retire the outdated daemon.");
    console.log(`Live output: ${DAEMON_LOG_FILE}`);
  }

  if (queue.length === 0) {
    console.log("Queue is empty");
    return;
  }

  console.log("");

  for (const task of queue) {
    console.log(
      `${task.id}  ${task.status.toUpperCase()}`
    );

    console.log(
      `  ${task.prompt}`
    );

    console.log(
      `  cwd: ${task.cwd}`
    );

    if (task.threadId) {
      console.log(
        `  session: ${task.threadId}`
      );
    } else if (task.last) {
      console.log("  session: last");
    }

    console.log(
      `  approval: ${task.approval || "auto"}${task.approval === "all" ? " (sandbox disabled)" : ""}`
    );

    if (task.runAfter) {
      console.log(
        `  retry: ${formatDate(task.runAfter)}`
      );
    }

    if (task.status === "waiting_quota" && task.nextPrompt) {
      console.log("  next: resume the same session after quota resets");
    }

    if (task.lastError) {
      console.log(`  reason: ${task.lastError}`);
    }

    if (task.status === "dispatched") {
      console.log("  terminal: opening");
    } else if (task.status === "running" && task.workerPid) {
      console.log(`  terminal: visible (worker ${task.workerPid})`);
    }

    if (task.status === "paused_session") {
      console.log(
        `  action: fully quit Codex Desktop or the terminal owning this session, then run cq retry ${task.id} (only this task is resumed)`
      );
    }

    console.log("");
  }
}

const [command, ...args] =
  process.argv.slice(2);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
switch (command) {
  case "__worker": {
    const [taskId, workerToken] = args;
    const ran = await runOneTask(taskId, workerToken);

    if (!ran) {
      process.exitCode = 1;
      break;
    }

    await sleep(3000);
    break;
  }

  case "add": {
    let parsed;

    try {
      parsed = parseArgs(args);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }

    const { prompt, cwd, threadId, last, approval } = parsed;

    if (!prompt) {
      console.error(
        'Usage: cq add "task" [--cwd DIRECTORY] [--session ID | --last] [--approval ask|auto|all]'
      );

      process.exit(1);
    }

    if (!fs.existsSync(cwd)) {
      console.error(
        `Directory does not exist: ${cwd}`
      );

      process.exit(1);
    }

    const queue = loadQueue();

    const task = {
      id: newId(),
      prompt,
      cwd,
      status: "queued",
      createdAt: Date.now(),
      runAfter: null,
      threadId,
      last,
      approval
    };

    queue.push(task);

    saveQueue(queue);

    console.log(
      `Added to queue: ${task.id}`
    );

    console.log(
      task.prompt
    );

    console.log(
      `cwd: ${cwd}`
    );

    if (threadId || last) {
      console.log(`session: ${threadId || "last"}`);
    }

    console.log(`approval: ${approval}${approval === "all" ? " (sandbox disabled)" : ""}`);

    const pid = ensureDaemon();
    console.log(`daemon: ${pid ? `running (${pid})` : "failed to start"}`);

    break;
  }

  case "list":
  case "status":
    listTasks();
    break;

  case "run":
    await runOneTask();
    break;

  case "daemon":
  case "deamon":
    await daemon();
    break;

  case "retry": {
    const queue = loadQueue();
    const all = args[0] === "--all";
    const task = queue.find(x => x.id === args[0]);
    const tasks = all ? queue.filter(retryable) : [task].filter(Boolean);

    if (!all && !task) {
      console.error(`Task not found: ${args[0] || "(missing ID)"}`);
      process.exit(1);
    }

    if (!all && !retryable(task)) {
      console.error(`Task ${task.id} is ${task.status} and cannot be retried`);
      process.exit(1);
    }

    if (!tasks.length) {
      console.log("No paused or failed tasks to retry");
      break;
    }

    tasks.forEach(requeue);
    saveQueue(queue);

    console.log(`Requeued: ${tasks.map(x => x.id).join(", ")}`);
    const pid = ensureDaemon();
    console.log(`daemon: ${pid ? `running (${pid})` : "failed to start"}`);
    break;
  }

  case "edit": {
    const queue = loadQueue();
    const task = queue.find(x => x.id === args[0]);

    if (!task) {
      console.error(`Task not found: ${args[0] || "(missing ID)"}`);
      process.exit(1);
    }

    if (args[1] !== "--approval" || args.length !== 3) {
      console.error("Usage: cq edit TASK_ID --approval ask|auto|all");
      process.exit(1);
    }

    if (["running", "dispatched", "done"].includes(task.status)) {
      console.error(`Task ${task.id} is ${task.status} and cannot be edited`);
      process.exit(1);
    }

    const approval = parseApproval(args[2]);

    if (approval === "ask" && !task.threadId) {
      console.error("Approval mode ask requires an explicit session ID");
      process.exit(1);
    }

    task.approval = approval;
    saveQueue(queue);
    console.log(`Updated ${task.id}: approval=${approval}`);
    break;
  }

  case "done": {
    const queue = loadQueue();
    const task = queue.find(x => x.id === args[0]);

    if (!task) {
      console.error(`Task not found: ${args[0] || "(missing ID)"}`);
      process.exit(1);
    }

    if (["dispatched", "running"].includes(task.status)) {
      console.error(`Task ${task.id} is active and cannot be marked done`);
      process.exit(1);
    }

    completeTask(task);
    saveQueue(queue);
    console.log(`Marked done: ${task.id}`);
    break;
  }

  case "remove": {
    const id = args[0];

    if (!id) {
      console.error(
        "Usage: cq remove TASK_ID"
      );

      process.exit(1);
    }

    let queue = loadQueue();

    const before = queue.length;

    queue = queue.filter(
      x => x.id !== id
    );

    saveQueue(queue);

    if (queue.length === before) {
      console.log(
        `Task not found: ${id}`
      );
    } else {
      console.log(
        `Removed: ${id}`
      );
    }

    break;
  }

  case "clear-done": {
    let queue = loadQueue();

    queue = queue.filter(
      x => x.status !== "done"
    );

    saveQueue(queue);

    console.log(
      "Removed completed tasks"
    );

    break;
  }

  default:
    console.log(`
Codex Queue (cq)

Commands:

  cq add "task"
  cq add "task" --cwd .
  cq add "continue task" --session SESSION_ID
  cq add "continue latest task" --last
  cq add "review changes" --session SESSION_ID --approval ask

  cq list
  cq run
  cq daemon
  cq retry TASK_ID
  cq retry --all
  cq edit TASK_ID --approval ask|auto|all
  cq done TASK_ID

  cq remove TASK_ID
  cq clear-done

Example:

  cq add "Run all tests and fix failures" --cwd .
`);
}
}

export {
  isQuotaError,
  isSessionBusyError,
  deferQueueForQuota,
  pauseForSession,
  retryable,
  requeue,
  completeTask,
  waitForQuota,
  codexInvocation,
  parseApproval,
  approvalArgs,
  parseRetryAt,
  quotaRetryAtFromSnapshot,
  parseArgs,
  eligibleTask,
  workerCommand
};

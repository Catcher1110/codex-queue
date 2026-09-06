#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CQ_HOME = path.resolve(process.env.CQ_HOME || path.join(os.homedir(), ".cq"));
const QUEUE_FILE = path.join(CQ_HOME, "queue.json");
const DAEMON_PID_FILE = path.join(CQ_HOME, "daemon.pid");
const DAEMON_LOG_FILE = path.join(CQ_HOME, "daemon.log");

fs.mkdirSync(CQ_HOME, { recursive: true });

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
function parseRetryAt(text) {
  const now = Date.now();

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

    const target = new Date();

    target.setHours(hour, minute, 30, 0);

    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime();
  }

  // Absolute 24-hour time
  const absolute24 = text.match(
    /(?:try again|reset(?:s)?|available again)[^\r\n]{0,50}?\bat\s+(\d{1,2}):(\d{2})/i
  );

  if (absolute24) {
    const target = new Date();

    target.setHours(
      Number(absolute24[1]),
      Number(absolute24[2]),
      30,
      0
    );

    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime();
  }

  return null;
}

function parseArgs(args) {
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
      task.runAfter = Math.max(task.runAfter || 0, retryAt);
      task.lastError = "quota";
    }
  }
}

function pauseForSession(task) {
  task.status = "paused_session";
  task.runAfter = null;
  task.lastError = "session is active in another Codex process";
}

function retryable(task) {
  return ["failed", "paused_session", "waiting_session"].includes(task.status);
}

function requeue(task) {
  task.status = "queued";
  task.runAfter = null;
  task.lastError = null;
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

function codexInvocation(task) {
  const approval = task.approval || "auto";
  const approvalOptions = approvalArgs(approval);

  if (task.threadId) {
    return {
      args: [
        ...approvalOptions,
        "queue",
        "--thread",
        task.threadId,
        "--message",
        task.prompt
      ],
      prompt: null,
      dispatched: true
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
      prompt: `
Continue the previously queued task from where you stopped.

Original task:
${task.prompt}

Finish the task completely.
`,
      dispatched: false
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
    prompt: task.prompt,
    dispatched: false
  };
}

function runCodex(task) {
  return new Promise(resolve => {
    const codexPath = findCodex();
    const { args, prompt, dispatched } = codexInvocation(task);

    if (task.threadId) {
      console.log(`\nDispatching to Codex App session: ${task.threadId}`);
    } else if (task.last) {
      console.log("\nResuming the latest Codex session");
    } else {
      console.log("\nStarting a new Codex session");
    }

    console.log(`Directory: ${task.cwd}`);
    console.log(`Task: ${task.prompt}\n`);

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
        threadId,
        dispatched
      });
    });

    child.on("close", code => {
      resolve({
        code,
        output: stdout + "\n" + stderr,
        threadId,
        dispatched
      });
    });

    child.stdin.on("error", () => {});
    if (prompt) child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runOneTask() {
  let queue = loadQueue();

  const now = Date.now();

  const task = queue.find(
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

  task.status = "running";
  task.startedAt = Date.now();

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
    let retryAt = parseRetryAt(result.output);

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

    current.status = "waiting_quota";
    current.runAfter = retryAt;
    current.lastError = "quota";
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

  if (result.code === 0 && result.dispatched) {
    current.status = "dispatched";
    current.dispatchedAt = Date.now();
    current.runAfter = null;
    current.lastError = null;

    console.log(`\nTask dispatched to Codex App: ${current.id}`);
  } else if (result.code === 0) {
    current.status = "done";
    current.completedAt = Date.now();
    current.runAfter = null;
    current.lastError = null;

    console.log(
      `\nTask completed: ${current.id}`
    );
  } else {
    current.status = "failed";
    current.runAfter = null;
    current.lastError =
      `Codex exit code: ${result.code}`;

    console.log(
      `\nTask failed with exit code ${result.code}`
    );
  }

  saveQueue(queue);

  return true;
}

async function daemon() {
  const existingPid = daemonPid();

  if (existingPid && existingPid !== process.pid) {
    console.log(`Codex Queue daemon is already running (${existingPid})`);
    return;
  }

  fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));
  process.on("exit", () => {
    if (daemonPid() === process.pid) {
      fs.rmSync(DAEMON_PID_FILE, { force: true });
    }
  });

  const queue = loadQueue();
  let recovered = 0;

  for (const task of queue) {
    if (task.status === "running") {
      task.status = "queued";
      recovered++;
    } else if (task.status === "waiting_session") {
      pauseForSession(task);
      recovered++;
    }
  }

  if (recovered) {
    saveQueue(queue);
    console.log(`Recovered ${recovered} interrupted task(s)`);
  }

  console.log("Codex Queue daemon started");
  console.log(`Queue: ${QUEUE_FILE}`);
  console.log("Press Ctrl+C to stop\n");

  while (true) {
    try {
      const ran = await runOneTask();

      if (ran) {
        // Brief pause between tasks.
        await sleep(3000);
      } else {
        await sleep(15000);
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

  if (
    !pid &&
    queue.some(task =>
      ["queued", "running", "waiting_quota"]
        .includes(task.status)
    )
  ) {
    pid = ensureDaemon();
  }

  console.log(`Daemon: ${pid ? `RUNNING (${pid})` : "STOPPED"}`);

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

    if (task.lastError) {
      console.log(`  reason: ${task.lastError}`);
    }

    if (task.status === "paused_session") {
      console.log(
        `  action: close the Codex task using this session, then run cq retry ${task.id} (only this task is resumed)`
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
  codexInvocation,
  parseApproval,
  approvalArgs,
  parseRetryAt,
  parseArgs
};

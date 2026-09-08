import assert from "node:assert/strict";
import path from "node:path";
import {
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
} from "./cq.js";

assert.deepEqual(
  parseArgs(["continue", "--session", "abc", "--cwd", "."]),
  {
    prompt: "continue",
    cwd: path.resolve("."),
    threadId: "abc",
    last: false,
    approval: "auto"
  }
);
assert.equal(parseArgs(["continue", "--last"]).last, true);
assert.throws(
  () => parseArgs(["continue", "--session", "abc", "--last"]),
  /cannot be used together/
);
assert.throws(() => parseArgs(["continue", "--session", "--last"]), /requires a value/);
assert.equal(
  parseArgs(["continue", "--session", "abc", "--approval", "ask"]).approval,
  "ask"
);
assert.throws(() => parseArgs(["continue", "--approval", "ask"]), /requires --session/);
assert.throws(() => parseArgs(["“continue", "--session", "abc"]), /straight quotes/);
assert.throws(() => parseArgs(["continue --session abc"]), /parsed as task text/);
assert.throws(() => parseApproval("invalid"), /ask, auto, or all/);
assert.deepEqual(approvalArgs("all"), ["--dangerously-bypass-approvals-and-sandbox"]);

const retryAt = parseRetryAt("usage limit reached; try again in 2 minutes");
assert.equal(isQuotaError("usage limit reached"), true);
assert.ok(retryAt >= Date.now() + 2 * 60_000);
assert.ok(retryAt <= Date.now() + 2 * 60_000 + 31_000);

const justAfterReset = new Date(2026, 8, 7, 3, 15, 45).getTime();
assert.equal(
  parseRetryAt("try again at 3:15 AM", justAfterReset),
  justAfterReset + 30000
);

const beforeMidnight = new Date(2026, 8, 7, 23, 50).getTime();
assert.equal(
  parseRetryAt("try again at 3:15 AM", beforeMidnight),
  new Date(2026, 8, 8, 3, 15, 30).getTime()
);

assert.equal(
  quotaRetryAtFromSnapshot({ rateLimits: { primary: { usedPercent: 100, resetsAt: 123 } } }, 1000),
  153000
);
assert.equal(
  quotaRetryAtFromSnapshot({ rateLimits: { primary: { usedPercent: 4, resetsAt: 123 } } }, 1000),
  31000
);

const nextDayReset = new Date(2026, 8, 8, 3, 15).getTime();
assert.equal(
  quotaRetryAtFromSnapshot(
    { rateLimits: { primary: { usedPercent: 100, resetsAt: nextDayReset / 1000 } } },
    beforeMidnight
  ),
  nextDayReset + 30000
);

assert.equal(
  isSessionBusyError("thread-store conflict: already has an active writer"),
  true
);

const queue = [
  { status: "waiting_quota", runAfter: 1 },
  { status: "queued", runAfter: null },
  { status: "paused_session", runAfter: null }
];
deferQueueForQuota(queue, 123);
assert.deepEqual(queue.map(x => x.status), ["waiting_quota", "waiting_quota", "paused_session"]);
assert.deepEqual(queue.map(x => x.runAfter), [123, 123, null]);

const busyTask = { status: "running", runAfter: 123, lastError: null };
pauseForSession(busyTask);
assert.deepEqual(busyTask, {
  status: "paused_session",
  runAfter: null,
  lastError: "session is active in another Codex process"
});

assert.equal(retryable(busyTask), true);
requeue(busyTask);
assert.deepEqual(busyTask, { status: "queued", runAfter: null, lastError: null });
assert.equal(retryable({ status: "waiting_quota" }), false);

const completedTask = { status: "paused_session", runAfter: 123, lastError: "busy" };
completeTask(completedTask);
assert.equal(completedTask.status, "done");
assert.equal(completedTask.runAfter, null);
assert.equal(completedTask.lastError, null);
assert.ok(completedTask.completedAt);

const quotaTask = {
  prompt: "original request",
  threadId: "session-1",
  status: "running",
  workerToken: "secret",
  workerPid: 123,
  dispatchedAt: 456
};
waitForQuota(quotaTask, 789);
assert.equal(quotaTask.prompt, "original request");
assert.equal(quotaTask.threadId, "session-1");
assert.equal(quotaTask.status, "waiting_quota");
assert.equal(quotaTask.runAfter, 789);
assert.match(quotaTask.nextPrompt, /Continue the unfinished work/);
assert.equal("workerToken" in quotaTask, false);

const quotaTaskWithoutSession = { prompt: "not started", status: "running" };
waitForQuota(quotaTaskWithoutSession, 789);
assert.equal("nextPrompt" in quotaTaskWithoutSession, false);

assert.deepEqual(
  codexInvocation({ threadId: "abc", prompt: "continue" }),
  {
    args: [
      "--approve-for-me",
      "exec",
      "resume",
      "abc",
      "--json",
      "--skip-git-repo-check",
      "-"
    ],
    prompt: "continue"
  }
);
assert.match(codexInvocation({ last: true, prompt: "continue" }).prompt, /continue/);
assert.equal(
  codexInvocation(quotaTask).prompt,
  quotaTask.nextPrompt
);

assert.equal(
  eligibleTask([
    { id: "done", status: "done" },
    { id: "active", status: "running" },
    { id: "next", status: "queued" }
  ]).id,
  "next"
);

const worker = workerCommand("task-1", "worker-token");
assert.equal(worker.title, "CQ Task task-1");
assert.deepEqual(worker.args.slice(-3), ["__worker", "task-1", "worker-token"]);
assert.equal(worker.args.some(value => value.includes("original request")), false);

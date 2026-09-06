import assert from "node:assert/strict";
import path from "node:path";
import {
  isQuotaError,
  isSessionBusyError,
  deferQueueForQuota,
  pauseForSession,
  retryable,
  requeue,
  parseRetryAt,
  parseArgs
} from "./cq.js";

assert.deepEqual(
  parseArgs(["continue", "--session", "abc", "--cwd", "."]),
  { prompt: "continue", cwd: path.resolve("."), threadId: "abc", last: false }
);
assert.equal(parseArgs(["continue", "--last"]).last, true);
assert.throws(
  () => parseArgs(["continue", "--session", "abc", "--last"]),
  /cannot be used together/
);
assert.throws(() => parseArgs(["continue", "--session", "--last"]), /requires a value/);

const retryAt = parseRetryAt("usage limit reached; try again in 2 minutes");
assert.equal(isQuotaError("usage limit reached"), true);
assert.ok(retryAt >= Date.now() + 2 * 60_000);
assert.ok(retryAt <= Date.now() + 2 * 60_000 + 31_000);

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

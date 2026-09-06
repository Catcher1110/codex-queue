# Codex Queue

`cq` is a small, dependency-free queue for Codex tasks. It runs new tasks through the non-interactive CLI and dispatches explicit session tasks to the Codex App, where they remain visible and interactive.

## Requirements

- Node.js 18 or newer
- Codex CLI installed, authenticated, and available on `PATH`

Verify both commands before installing:

```text
node --version
codex --version
```

## Install

Run `npm link` from this repository, not from the project whose tasks you want to queue.

### Windows

```bat
cd /d C:\path\to\codex-queue
npm link
cq
```

### Ubuntu

```bash
cd /path/to/codex-queue
chmod +x cq.js
npm link
cq
```

No platform-specific dependency is required. Windows uses the npm command shim and hidden processes; Ubuntu uses the executable shebang and detached processes.

## Configuration

Queue data defaults to `.cq` inside the current user's home directory. Set `CQ_HOME` to store it elsewhere.

Windows Command Prompt:

```bat
set CQ_HOME=D:\path\to\cq-data
```

PowerShell:

```powershell
$env:CQ_HOME = "D:\path\to\cq-data"
```

Ubuntu:

```bash
export CQ_HOME=/path/to/cq-data
```

The directory contains:

- `queue.json` — task state
- `daemon.pid` — background daemon process ID
- `daemon.log` — background daemon output and errors

## Usage

Add a new task. The working directory defaults to the current directory:

```text
cq add "Run all tests and fix failures"
cq add "Run all tests and fix failures" --cwd /path/to/project
```

Dispatch to a specific Codex App session, or resume the latest session non-interactively:

```text
cq add "Continue the analysis" --session SESSION_ID
cq add "Continue the analysis" --last
```

`--session ID` uses the native `codex queue` command. The Codex App owns execution, displays progress, and handles permission requests. CQ records successful handoff as `DISPATCHED`; inspect the session in the App for its final result.

`--last` uses `codex exec resume --last` because the native queue command requires an explicit session ID. Use `--session ID` when App visibility or interactive approval is required.

### Approval modes

Choose a policy when adding a task:

```text
cq add "Deploy the change" --session SESSION_ID --approval ask
cq add "Run the test suite" --approval auto
cq add "Run in a disposable environment" --approval all
```

| Mode | Behavior |
| --- | --- |
| `ask` | Show permission requests in the Codex App. Requires an explicit `--session ID`. |
| `auto` | Use Codex automatic approval review inside the workspace-write sandbox. This is the default. |
| `all` | Approve everything by disabling approvals and the sandbox. Use only in an environment you are willing to give full access. |

Change the policy before a task starts or is dispatched:

```text
cq edit TASK_ID --approval ask
cq edit TASK_ID --approval auto
cq edit TASK_ID --approval all
```

Running, dispatched, and completed tasks cannot be edited. Pause or finish them first; CQ never changes an active request's permissions underneath it.

Inspect the daemon and every queued task:

```text
cq list
cq status
```

Retry one paused or failed task, or all paused and failed tasks:

```text
cq retry TASK_ID
cq retry --all
cq edit TASK_ID --approval ask|auto|all
```

`retry --all` does not touch running, dispatched, completed, or usage-limited tasks. A session-paused task does not block later queued tasks.

Other commands:

```text
cq run                 Run one eligible task in the foreground
cq daemon              Run the daemon in the foreground
cq remove TASK_ID      Remove one task
cq clear-done          Remove completed tasks
```

The common `cq deamon` misspelling is accepted as an alias for `cq daemon`.

## Task states

| State | Meaning | What to do |
| --- | --- | --- |
| `QUEUED` | Ready to run | Nothing |
| `RUNNING` | Codex is executing the task | Nothing |
| `DISPATCHED` | CQ handed the message to the Codex App | Follow progress and handle permissions in the App |
| `WAITING_QUOTA` | The account usage limit was reached | Wait; retry is automatic at the displayed time |
| `PAUSED_SESSION` | The session is open in another Codex process | Close that Codex task, then run the displayed `cq retry TASK_ID` command |
| `DONE` | Task completed successfully | Optionally run `cq clear-done` |
| `FAILED` | Codex exited with another error | Fix the cause, then run `cq retry TASK_ID` |

## Processing flow

```mermaid
flowchart TD
    A[cq add] --> B[Validate task, directory, and session options]
    B --> C[Save task as QUEUED]
    C --> D{Daemon running?}
    D -- No --> E[Start hidden daemon]
    D -- Yes --> F[Select next eligible task]
    E --> F
    F --> G{Explicit session ID?}
    G -- Yes --> R[codex queue sends message to Codex App]
    R --> S[DISPATCHED]
    S --> T[View progress and handle ask-mode permissions in Codex App]
    G -- No --> H[Run Codex CLI non-interactively]
    H --> I{Result}
    I -- Success --> J[DONE]
    I -- Usage limit --> K[Mark pending tasks WAITING_QUOTA]
    K --> L[Wait until reset time]
    L --> F
    I -- Session active elsewhere --> M[Pause only this task as PAUSED_SESSION]
    M --> N[User closes the other Codex task]
    N --> O[cq retry TASK_ID]
    O --> F
    I -- Other error --> P[FAILED]
    F --> Q[Later queued tasks continue]
```

## Troubleshooting

### `npm error enoent ... package.json`

Run `npm link` from the `codex-queue` directory. The target project does not need a `package.json`.

### A session is paused

`cq list` prints the session conflict and the exact retry command. Close the Codex task that currently owns that session before retrying it.

### The daemon stops

`cq add` starts it automatically. `cq list` also restarts it when runnable work exists. Inspect `daemon.log` under `CQ_HOME` for errors.

## Development

```text
npm test
```

The project intentionally uses only Node.js standard-library modules.

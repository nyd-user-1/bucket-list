# Bucket List: desktop app

A native macOS window for Bucket List, built the way HQ is: a small Swift
shell (`NSWindow` + `WKWebView`) starts a local server as a child process on
its own port and shows it in the window. Quitting the app stops the server.

The server (`server.js`) has no dependencies and no build step. It drives the
same engine the npm CLI runs (`../lib`: discovery, estimate, sweep, renderer),
so the dashboard in the window is the same HTML file `bucket-list` writes.

## Run

From the repo:

```
app/bin/bucket-list-app             # assemble "Bucket List.app" if needed, then open it
app/bin/bucket-list-app --rebuild   # reassemble after editing app/ or lib/
app/bin/bucket-list-app --browser   # same UI in the browser, server in this terminal
```

The app is assembled into `~/Applications/Bucket List.app` (override with
`BUCKET_LIST_APP_INSTALL`), so after the first run it also opens from
Spotlight. It serves on `localhost:3011` (`BUCKET_LIST_PORT` to change; HQ
uses 3009).

Requirements: macOS 12+, Node.js 18+, Xcode Command Line Tools (`swiftc`, used
once to compile the window), and the AWS CLI v2 signed in. The app isn't
signed, notarized, or packaged as an installer; it runs on the Mac that
assembled it.

## Flow

1. **Check.** It verifies the AWS CLI is installed and `sts get-caller-identity`
   succeeds. If not, it shows what to install or which sign-in command to run,
   with a Check again button.
2. **Estimate.** It lists every bucket with CloudWatch's object count, size,
   and monthly storage cost. Pick a subset, read the request count and cost of
   the sweep, and press Proceed. This is the CLI's `Proceed? [y/N]` guardrail
   as a screen.
3. **Sweep.** Buckets sweep in parallel with live progress.
4. **Dashboard.** The report renders in the window: drill down by bucket and
   folder, search everything. **Refresh** re-sweeps the same buckets,
   **Buckets…** returns to the estimate, and **Export HTML** saves the
   standalone file.

Credentials come from the AWS CLI's default profile. A GUI app doesn't inherit
shell variables, so to use another profile run
`AWS_PROFILE=name app/bin/bucket-list-app --browser`, or set it as the default.

Annotations work as in the CLI: put the JSON at `~/.bucket-list/notes.json`,
or point `BUCKET_LIST_NOTES` at another file.

## Layout

```
app/
  server.js                    zero-dependency HTTP server + JSON API over ../lib
  ui/index.html                check / estimate / sweep / dashboard screens
  shell/bucket-list-shell.swift  the native window (HQ's shell, trimmed)
  scripts/make-macos-app.sh    assembles the .app (copies server, UI, ../lib; compiles the shell)
  bin/bucket-list-app          the front door
```

AWS access is read-only: `s3api list-buckets`, `get-bucket-location`,
`list-objects-v2`, `s3 ls`, `cloudwatch get-metric-data`, and
`sts get-caller-identity`. No object is downloaded or modified.

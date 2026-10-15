# Bucket List: desktop app

A native macOS window for Bucket List, built the way HQ is: a small Swift
shell (`NSWindow` + `WKWebView`) starts a local server as a child process on
its own port and shows it in the window. Quitting the app stops the server.

The server (`server.js`) has no dependencies and no build step. It drives the
same engine the npm CLI runs (`../lib`: discovery, estimate, sweep, renderer),
so the dashboard in the window is the same HTML file `bucket-list` writes.

## Run

Download `Bucket-List-macOS.zip` from the
[latest release](https://github.com/nyd-user-1/bucket-list/releases/latest),
unzip, and move `Bucket List.app` to Applications. It's ad-hoc signed, not
notarized: the first open is blocked, then System Settings → Privacy & Security
→ Open Anyway lets it run. It needs Node.js 18+ and the AWS CLI on the Mac.

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

Requirements: macOS 12+, Node.js 18+, the AWS CLI v2 signed in, and (to build
from source) Xcode Command Line Tools for `swiftc`. `app/scripts/package-release.sh`
builds the universal, ad-hoc-signed release zip into `app/dist/`.

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
  scripts/package-release.sh   zips it for a GitHub release
  bin/bucket-list-app          the front door
```

AWS access is read-only: `s3api list-buckets`, `get-bucket-location`,
`list-objects-v2`, `s3 ls`, `cloudwatch get-metric-data`, and
`sts get-caller-identity`. No object is downloaded or modified.

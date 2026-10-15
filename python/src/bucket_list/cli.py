import json
import math
import os
import shutil
import subprocess
import sys
import time

from . import __version__
from .aws import run, set_concurrency
from .render import render
from .sweep import discover_buckets, estimate, sweep_buckets

HELP = """Bucket List %s — lightweight search for S3

Sweeps every bucket in the AWS account your CLI is signed into and writes one
self-contained HTML file: drill down by bucket and folder, object counts,
storage-class cost estimates, largest files, and instant search. Works offline
once generated. Requires the AWS CLI (v2) configured with list permissions.

Usage: bucket-list [options]

  --output <file>       output path            (default: bucket-list.html)
  --buckets <a,b,c>     only these buckets     (default: every bucket)
  --notes <file>        annotations JSON       (default: ./bucket-list.notes.json if present)
  --concurrency <n>     parallel AWS calls     (default: 12)
  --yes                 skip the cost estimate confirmation
  --open                open the file when done
  --version             print version
  --help                this text

Annotations file format (all fields optional):
  { "my-bucket": { "verdict": "keep|review|disposable|empty",
                   "note": "shown on the bucket's row and page",
                   "project": "label under the bucket name" } }

Cost note: the sweep itself uses S3 LIST requests at $0.005 per 1,000 — about
five cents per 10 million objects — plus one CloudWatch query per 50 buckets.
It reads names and sizes only; no object is ever downloaded or modified.""" % __version__


def err(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def parse_args(argv):
    a = {"output": "bucket-list.html", "buckets": None, "notes": None, "concurrency": 12, "yes": False, "open": False}
    i = 0

    def value():
        if i + 1 >= len(argv):
            err("missing value for %s (try --help)" % argv[i])
            sys.exit(2)
        return argv[i + 1]

    while i < len(argv):
        v = argv[i]
        if v in ("--help", "-h"):
            print(HELP)
            sys.exit(0)
        elif v == "--version":
            print(__version__)
            sys.exit(0)
        elif v in ("--yes", "-y"):
            a["yes"] = True
        elif v == "--open":
            a["open"] = True
        elif v == "--output":
            a["output"] = value()
            i += 1
        elif v == "--buckets":
            a["buckets"] = [s.strip() for s in value().split(",") if s.strip()]
            i += 1
        elif v == "--notes":
            a["notes"] = value()
            i += 1
        elif v == "--concurrency":
            try:
                a["concurrency"] = int(value()) or 12
            except ValueError:
                a["concurrency"] = 12
            i += 1
        else:
            err("unknown option: %s (try --help)" % v)
            sys.exit(2)
        i += 1
    return a


def fmt_bytes(b):
    if b < 1024 ** 3:
        return "%.0f MB" % (b / 1024 ** 2)
    if b < 1024 ** 4:
        return "%.1f GB" % (b / 1024 ** 3)
    return "%.2f TB" % (b / 1024 ** 4)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    set_concurrency(args["concurrency"])

    # 0. preconditions
    if not shutil.which("aws"):
        err("The AWS CLI was not found. Install it and run `aws configure`, then retry.")
        return 1
    try:
        account = run(["sts", "get-caller-identity"]).get("Account", "")
    except Exception as e:
        err("AWS credentials aren't working: %s" % e)
        err("Run `aws configure` (or set your profile/SSO session) and retry.")
        return 1

    # 1. discovery
    err("Discovering buckets in account %s..." % account)
    try:
        buckets, skipped = discover_buckets(args["buckets"], args["concurrency"])
    except Exception as e:
        err(str(e))
        return 1
    for s in skipped:
        err("  skipping %s: no access to its region/location" % s["name"])
    if not buckets:
        err("No buckets to sweep.")
        return 1

    # 2. estimate + guardrail
    stats = estimate(buckets)
    est_objects = sum(stats[b["name"]]["cwObjects"] for b in buckets)
    est_bytes = sum(sum(stats[b["name"]]["classes"].values()) for b in buckets) * 1024 ** 3
    est_requests = math.ceil(est_objects / 1000 * 1.2) + len(buckets) * 3
    est_cost = est_requests / 1000 * 0.005
    est_minutes = max(1, int(math.floor(est_requests * 0.12 / args["concurrency"] / 60 + 0.5)))
    err(
        "%d buckets, ~%s objects, ~%s (CloudWatch estimate).\n"
        "Sweep will make ~%s LIST requests: ~$%s, roughly %d min."
        % (len(buckets), "{:,}".format(est_objects), fmt_bytes(est_bytes), "{:,}".format(est_requests),
           "0.01" if est_cost < 0.005 else "%.2f" % est_cost, est_minutes)
    )
    if not args["yes"]:
        if not sys.stdin.isatty():
            err("Not a terminal; re-run with --yes to proceed without confirmation.")
            return 1
        sys.stderr.write("Proceed? [y/N] ")
        sys.stderr.flush()
        ans = sys.stdin.readline().strip().lower()
        if ans not in ("y", "yes"):
            err("Aborted. Nothing was swept.")
            return 0

    # 3. sweep
    t0 = time.time()
    progress = {"done": 0}

    def on_done(b, r, e):
        progress["done"] += 1
        if e:
            err("  %s: FAILED (%s)" % (b["name"], e))
        err("  [%d/%d] %s" % (progress["done"], len(buckets), b["name"]))

    results = sweep_buckets(buckets, args["concurrency"], on_done)

    # 4. annotations
    notes = {}
    notes_path = args["notes"] or ("bucket-list.notes.json" if os.path.exists("bucket-list.notes.json") else None)
    if notes_path:
        try:
            with open(notes_path, encoding="utf-8") as f:
                notes = json.load(f)
            err("Annotations loaded from %s." % notes_path)
        except Exception as e:
            err("Could not read %s: %s (continuing without annotations)" % (notes_path, e))

    # 5. render
    html = render(results, stats, notes, account)
    out = os.path.abspath(args["output"])
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    total_n = sum(r["n"] for r in results)
    total_b = sum(r["b"] for r in results)
    err(
        "\nSwept %s objects (%s) across %d buckets in %ds."
        % ("{:,}".format(total_n), fmt_bytes(total_b), len(results), int(round(time.time() - t0)))
    )
    print(out)

    if args["open"]:
        if sys.platform == "darwin":
            subprocess.Popen(["open", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "win32":
            os.startfile(out)  # noqa: no-member on non-Windows
        else:
            subprocess.Popen(["xdg-open", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


def entry():
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        err("Interrupted.")
        sys.exit(130)

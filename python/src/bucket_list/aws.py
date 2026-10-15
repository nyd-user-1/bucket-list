"""Thin wrappers around the AWS CLI. No SDK, no dependencies: if `aws` works in
the user's terminal, Bucket List works, regardless of what else they use."""
import json
import re
import subprocess
import threading

_sem = threading.BoundedSemaphore(12)


def set_concurrency(n):
    global _sem
    _sem = threading.BoundedSemaphore(max(1, int(n)))


class AwsError(Exception):
    pass


def run(args, json_out=True, region=None):
    """Run an aws CLI command, return parsed JSON (or raw text with json_out=False)."""
    full = ["aws"] + list(args)
    if json_out:
        full += ["--output", "json"]
    if region:
        full += ["--region", region]
    with _sem:
        p = subprocess.run(full, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if p.returncode != 0:
        msg = p.stderr.strip()[:300] or "exit %d" % p.returncode
        raise AwsError("aws %s failed: %s" % (" ".join(args[:3]), msg))
    if not json_out:
        return p.stdout
    try:
        return json.loads(p.stdout) if p.stdout.strip() else {}
    except ValueError as e:
        raise AwsError("bad JSON from aws %s %s: %s" % (args[0], args[1], e))


_LS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) +\S+ +(\d+) (.*)$")


def stream_ls(s3url, region, on_object):
    """Stream `aws s3 ls <url> --recursive` line by line.

    Calls on_object(date_yyyy_mm_dd, size_bytes, key) per object. Constant
    memory, works for millions of objects."""
    args = ["aws", "s3", "ls", s3url, "--recursive"]
    if region:
        args += ["--region", region]
    with _sem:
        p = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1 << 16,
        )
        err = []
        t = threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True)
        t.start()
        for line in p.stdout:
            m = _LS_RE.match(line.rstrip("\n"))
            if m:
                on_object(m.group(1), int(m.group(2)), m.group(3))
        code = p.wait()
        t.join()
    stderr = "".join(err).strip()
    # `aws s3 ls` exits 1 on an empty prefix with no stderr; that's fine.
    if code != 0 and stderr:
        raise AwsError("aws s3 ls %s failed: %s" % (s3url, stderr[:300]))

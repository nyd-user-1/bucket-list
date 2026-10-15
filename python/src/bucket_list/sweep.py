"""Discovery, cost estimation, and the recursive sharded sweep."""
import datetime
import json
import os
import queue
import re
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

from .aws import run, stream_ls

# $/GB-month at us-east-1 list prices, keyed by CloudWatch StorageType.
# Prices vary by region and change over time; everything derived from these
# is labeled an estimate in the output.
STORAGE_PRICES = {
    "StandardStorage": 0.023,
    "StandardIAStorage": 0.0125,
    "OneZoneIAStorage": 0.01,
    "GlacierInstantRetrievalStorage": 0.004,
    "GlacierStorage": 0.0036,
    "DeepArchiveStorage": 0.00099,
    "IntelligentTieringFAStorage": 0.023,
    "IntelligentTieringIAStorage": 0.0125,
}

# ---------------------------------------------------------------- discovery


def discover_buckets(only_names=None, workers=12):
    res = run(["s3api", "list-buckets"])
    names = [b["Name"] for b in res.get("Buckets") or []]
    if only_names:
        have = set(names)
        for n in only_names:
            if n not in have:
                raise ValueError("bucket not found in this account: %s" % n)
        want = set(only_names)
        names = [n for n in names if n in want]

    def locate(name):
        try:
            lc = run(["s3api", "get-bucket-location", "--bucket", name])
            region = lc.get("LocationConstraint") or "us-east-1"
            if region == "EU":
                region = "eu-west-1"
            return {"name": name, "region": region}, None
        except Exception as e:
            return None, {"name": name, "reason": str(e)}

    buckets, skipped = [], []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for ok, bad in ex.map(locate, names):
            if ok:
                buckets.append(ok)
            else:
                skipped.append(bad)
    buckets.sort(key=lambda b: b["name"])
    return buckets, skipped


# ---------------------------------------------------------------- estimate


def estimate(buckets):
    """CloudWatch daily storage metrics, batched per region, <=50 buckets/call.

    Returns {bucket: {"cwObjects": int, "classes": {type: GB}, "estMonthly": usd}}."""
    by_region = {}
    for b in buckets:
        by_region.setdefault(b["region"], []).append(b["name"])
    stats = {b["name"]: {"cwObjects": 0, "classes": {}, "estMonthly": 0.0} for b in buckets}

    end = datetime.datetime.now(datetime.timezone.utc)
    start = end - datetime.timedelta(days=3)
    types = list(STORAGE_PRICES)

    def metric(name, bucket, storage_type):
        return {
            "Namespace": "AWS/S3",
            "MetricName": name,
            "Dimensions": [
                {"Name": "BucketName", "Value": bucket},
                {"Name": "StorageType", "Value": storage_type},
            ],
        }

    for region, names in by_region.items():
        for i in range(0, len(names), 50):
            chunk = names[i : i + 50]
            queries = []
            for bi, name in enumerate(chunk):
                queries.append({
                    "Id": "c%d" % bi,
                    "MetricStat": {"Metric": metric("NumberOfObjects", name, "AllStorageTypes"), "Period": 86400, "Stat": "Average"},
                    "ReturnData": True,
                })
                for ti, t in enumerate(types):
                    queries.append({
                        "Id": "s%d_%d" % (bi, ti),
                        "MetricStat": {"Metric": metric("BucketSizeBytes", name, t), "Period": 86400, "Stat": "Average"},
                        "ReturnData": True,
                    })
            fd, qfile = tempfile.mkstemp(prefix="bucketlist-q-", suffix=".json")
            with os.fdopen(fd, "w") as f:
                json.dump(queries, f)
            try:
                res = run(
                    [
                        "cloudwatch", "get-metric-data",
                        "--metric-data-queries", "file://" + qfile,
                        "--start-time", start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "--end-time", end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "--scan-by", "TimestampDescending",
                    ],
                    region=region,
                )
                for m in res.get("MetricDataResults") or []:
                    vals = m.get("Values") or []
                    if not vals:
                        continue
                    v = vals[0]
                    mid = m.get("Id", "")
                    mm = re.match(r"^c(\d+)$", mid) or re.match(r"^s(\d+)_(\d+)$", mid)
                    if not mm:
                        continue
                    st = stats[chunk[int(mm.group(1))]]
                    if mid.startswith("c"):
                        st["cwObjects"] = int(round(v))
                    else:
                        t = types[int(mm.group(2))]
                        gb = v / 1024 ** 3
                        if gb > 0.001:
                            st["classes"][t] = gb
                            st["estMonthly"] += gb * STORAGE_PRICES[t]
            except Exception:
                # CloudWatch denied or absent: the sweep still works, costs show as 0.
                pass
            finally:
                os.unlink(qfile)
    return stats


# ---------------------------------------------------------------- aggregator

_HEX = re.compile(r"[0-9a-fA-F]{6,}")
_DIG = re.compile(r"\d+")


def _new_node():
    return {"n": 0, "b": 0, "o": "9999", "w": "", "ext": {}, "fam": {}, "c": {}}


def _bump(node, size, lm, ext, pat):
    node["n"] += 1
    node["b"] += size
    if lm < node["o"]:
        node["o"] = lm
    if lm > node["w"]:
        node["w"] = lm
    node["ext"][ext] = node["ext"].get(ext, 0) + size
    fam = node["fam"]
    f = fam.get(pat)
    if f:
        f[0] += 1
        f[1] += size
    else:
        fam[pat] = [1, size]
        if len(fam) > 1200:
            keep = sorted(fam.items(), key=lambda kv: -kv[1][1])[:500]
            node["fam"] = dict(keep)


class Aggregate:
    def __init__(self):
        self.n = 0
        self.b = 0
        self.nodes = {}
        self.largest = []
        self.lock = threading.Lock()

    def add(self, key, size, lm):
        parts = key.split("/")
        fn = parts[-1]
        pat = _DIG.sub("#", _HEX.sub("#", fn))[:80]
        dot = fn.rfind(".")
        ext = fn[dot:].lower() if dot > 0 and len(fn) - dot <= 10 else "(none)"
        l1 = parts[0] + "/" if len(parts) > 1 else "(root)"
        with self.lock:
            self.n += 1
            self.b += size
            n1 = self.nodes.get(l1)
            if n1 is None:
                n1 = self.nodes[l1] = _new_node()
            _bump(n1, size, lm, ext, pat)
            if len(parts) > 2:
                l2 = parts[0] + "/" + parts[1] + "/"
                n2 = n1["c"].get(l2)
                if n2 is None:
                    n2 = n1["c"][l2] = _new_node()
                _bump(n2, size, lm, ext, pat)
            self.largest.append((size, key, lm))
            if len(self.largest) > 400:
                self.largest.sort(key=lambda x: -x[0])
                del self.largest[12:]


def _ser_node(name, node, with_kids):
    out = {
        "p": name,
        "n": node["n"],
        "b": node["b"],
        "o": node["o"],
        "w": node["w"],
        "x": [list(kv) for kv in sorted(node["ext"].items(), key=lambda kv: -kv[1])[:3]],
        "f": [[p, c[0], c[1]] for p, c in sorted(node["fam"].items(), key=lambda kv: -kv[1][1])[:6]],
    }
    if with_kids and node["c"]:
        kids = sorted(node["c"].items(), key=lambda kv: -kv[1]["b"])
        out["c"] = [_ser_node(k, v, False) for k, v in kids[:30]]
        if len(kids) > 30:
            rest = kids[30:]
            out["c"].append({
                "p": "(%d more)" % len(rest),
                "n": sum(v["n"] for _, v in rest),
                "b": sum(v["b"] for _, v in rest),
                "o": "", "w": "", "x": [], "f": [],
            })
    return out


def serialize(agg, bucket):
    agg.largest.sort(key=lambda x: -x[0])
    prefs = sorted(agg.nodes.items(), key=lambda kv: -kv[1]["b"])
    return {
        "bucket": bucket,
        "n": agg.n,
        "b": agg.b,
        "largest": [[k, s, d] for s, k, d in agg.largest[:12]],
        "prefixes": [_ser_node(k, v, True) for k, v in prefs[:40]],
    }


# ---------------------------------------------------------------- walker

SPLIT_DEPTH = 4  # below this, stream flat
KID_LIMIT = 1500  # folder explosion guard at the bucket root
KID_SPLIT_MAX = 64  # deeper levels: more folders than this means a
# partitioned layout (dt=2025-03-21/ style); one stream beats 10,000 spawns
PAGE_CAP = 50000  # max entries to hold from one delimiter listing


def _flat(bucket, region, prefix, agg):
    stream_ls("s3://%s/%s" % (bucket, prefix), region, lambda d, s, k: agg.add(k, s, d))


def _walk(bucket, region, prefix, depth, agg):
    """List one level; return child prefixes to walk next (in parallel)."""
    if depth >= SPLIT_DEPTH:
        _flat(bucket, region, prefix, agg)
        return []
    try:
        res = run(
            [
                "s3api", "list-objects-v2",
                "--bucket", bucket,
                "--prefix", prefix,
                "--delimiter", "/",
                "--max-items", str(PAGE_CAP),
            ],
            region=region,
        )
    except Exception:
        # fall back to a flat stream on any listing hiccup
        _flat(bucket, region, prefix, agg)
        return []
    kids = [p["Prefix"] for p in res.get("CommonPrefixes") or []]
    kid_cap = KID_LIMIT if depth == 0 else KID_SPLIT_MAX
    if res.get("NextToken") or len(kids) > kid_cap:
        # too big or too many folders at this level: stream the whole subtree
        # (nothing from this listing was merged, so no double counting)
        _flat(bucket, region, prefix, agg)
        return []
    for o in res.get("Contents") or []:
        agg.add(o["Key"], int(o["Size"]), str(o["LastModified"])[:10])
    return kids


def sweep_buckets(buckets, concurrency=12, on_done=None):
    """Sweep every bucket through one global pool of `concurrency` workers.

    Each folder listing is its own task, so a single huge bucket fans out
    across the whole pool. on_done(bucket_dict, result, error) fires as each
    bucket finishes. Returns results in the order of `buckets`."""
    tasks = queue.Queue()
    state = {}
    lock = threading.Lock()

    for b in buckets:
        state[b["name"]] = {"agg": Aggregate(), "pending": 1, "error": None, "bucket": b}
        tasks.put((b["name"], "", 0))

    results = {}

    def finish(name):
        s = state[name]
        b = s["bucket"]
        if s["error"]:
            r = {"bucket": name, "n": 0, "b": 0, "largest": [], "prefixes": []}
        else:
            r = serialize(s["agg"], name)
        r["region"] = b["region"]
        results[name] = r
        if on_done:
            on_done(b, r, s["error"])

    def worker():
        while True:
            item = tasks.get()
            if item is None:
                tasks.task_done()
                return
            name, prefix, depth = item
            s = state[name]
            kids = []
            if not s["error"]:
                try:
                    kids = _walk(name, s["bucket"]["region"], prefix, depth, s["agg"])
                except Exception as e:
                    s["error"] = e
            with lock:
                s["pending"] += len(kids) - 1
                done = s["pending"] == 0
            for k in kids:
                tasks.put((name, k, depth + 1))
            if done:
                finish(name)
            tasks.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, int(concurrency)))]
    for t in threads:
        t.start()
    tasks.join()
    for _ in threads:
        tasks.put(None)
    for t in threads:
        t.join()
    return [results[b["name"]] for b in buckets]


def sweep_bucket(bucket, region, concurrency=12):
    return sweep_buckets([{"name": bucket, "region": region}], concurrency)[0]

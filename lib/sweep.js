"use strict";
// Discovery, cost estimation, and the recursive sharded sweep.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, streamLs } = require("./aws");

// $/GB-month at us-east-1 list prices, keyed by CloudWatch StorageType.
// Prices vary by region and change over time; everything derived from these
// is labeled an estimate in the output.
const STORAGE_PRICES = {
  StandardStorage: 0.023,
  StandardIAStorage: 0.0125,
  OneZoneIAStorage: 0.01,
  GlacierInstantRetrievalStorage: 0.004,
  GlacierStorage: 0.0036,
  DeepArchiveStorage: 0.00099,
  IntelligentTieringFAStorage: 0.023,
  IntelligentTieringIAStorage: 0.0125,
};

// ---------------------------------------------------------------- discovery

async function discoverBuckets(onlyNames) {
  const res = await run(["s3api", "list-buckets"]);
  let names = (res.Buckets || []).map((b) => b.Name);
  if (onlyNames && onlyNames.length) {
    const want = new Set(onlyNames);
    const have = new Set(names);
    for (const n of onlyNames) {
      if (!have.has(n)) throw new Error(`bucket not found in this account: ${n}`);
    }
    names = names.filter((n) => want.has(n));
  }
  const buckets = [];
  const skipped = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        const lc = await run(["s3api", "get-bucket-location", "--bucket", name]);
        let region = lc.LocationConstraint || "us-east-1";
        if (region === "EU") region = "eu-west-1";
        buckets.push({ name, region });
      } catch (e) {
        skipped.push({ name, reason: e.message });
      }
    })
  );
  buckets.sort((a, b) => a.name.localeCompare(b.name));
  return { buckets, skipped };
}

// ---------------------------------------------------------------- estimate

async function estimate(buckets) {
  // CloudWatch daily storage metrics, batched per region, <=50 buckets/call.
  const byRegion = new Map();
  for (const b of buckets) {
    if (!byRegion.has(b.region)) byRegion.set(b.region, []);
    byRegion.get(b.region).push(b.name);
  }
  const stats = new Map(); // name -> {cwObjects, classes:{type:GB}, estMonthly}
  for (const b of buckets) stats.set(b.name, { cwObjects: 0, classes: {}, estMonthly: 0 });

  const end = new Date();
  const start = new Date(end.getTime() - 3 * 86400 * 1000);
  const types = Object.keys(STORAGE_PRICES);

  for (const [region, names] of byRegion) {
    for (let i = 0; i < names.length; i += 50) {
      const chunk = names.slice(i, i + 50);
      const queries = [];
      chunk.forEach((name, bi) => {
        queries.push({
          Id: `c${bi}`,
          MetricStat: {
            Metric: {
              Namespace: "AWS/S3",
              MetricName: "NumberOfObjects",
              Dimensions: [
                { Name: "BucketName", Value: name },
                { Name: "StorageType", Value: "AllStorageTypes" },
              ],
            },
            Period: 86400,
            Stat: "Average",
          },
          ReturnData: true,
        });
        types.forEach((t, ti) => {
          queries.push({
            Id: `s${bi}_${ti}`,
            MetricStat: {
              Metric: {
                Namespace: "AWS/S3",
                MetricName: "BucketSizeBytes",
                Dimensions: [
                  { Name: "BucketName", Value: name },
                  { Name: "StorageType", Value: t },
                ],
              },
              Period: 86400,
              Stat: "Average",
            },
            ReturnData: true,
          });
        });
      });
      const qfile = path.join(os.tmpdir(), `bucketlist-q-${process.pid}-${i}.json`);
      fs.writeFileSync(qfile, JSON.stringify(queries));
      try {
        const res = await run(
          [
            "cloudwatch", "get-metric-data",
            "--metric-data-queries", `file://${qfile}`,
            "--start-time", start.toISOString(),
            "--end-time", end.toISOString(),
            "--scan-by", "TimestampDescending",
          ],
          { region }
        );
        for (const m of res.MetricDataResults || []) {
          if (!m.Values || !m.Values.length) continue;
          const v = m.Values[0];
          const mm = /^c(\d+)$/.exec(m.Id) || /^s(\d+)_(\d+)$/.exec(m.Id);
          if (!mm) continue;
          const st = stats.get(chunk[parseInt(mm[1], 10)]);
          if (m.Id.startsWith("c")) {
            st.cwObjects = Math.round(v);
          } else {
            const t = types[parseInt(mm[2], 10)];
            const gb = v / 1024 ** 3;
            if (gb > 0.001) {
              st.classes[t] = gb;
              st.estMonthly += gb * STORAGE_PRICES[t];
            }
          }
        }
      } catch (e) {
        // CloudWatch denied or absent: the sweep still works, costs show as 0.
      } finally {
        fs.unlinkSync(qfile);
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------- aggregator

function newNode() {
  return { n: 0, b: 0, o: "9999", w: "", ext: new Map(), fam: new Map(), c: new Map() };
}

function bump(node, size, lm, ext, pat) {
  node.n++;
  node.b += size;
  if (lm < node.o) node.o = lm;
  if (lm > node.w) node.w = lm;
  node.ext.set(ext, (node.ext.get(ext) || 0) + size);
  const f = node.fam.get(pat);
  if (f) {
    f[0]++;
    f[1] += size;
  } else {
    node.fam.set(pat, [1, size]);
  }
  if (node.fam.size > 1200) {
    const keep = [...node.fam.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 500);
    node.fam = new Map(keep);
  }
}

function newAgg() {
  return { n: 0, b: 0, nodes: new Map(), largest: [] };
}

function aggAdd(agg, key, size, lm) {
  agg.n++;
  agg.b += size;
  const parts = key.split("/");
  const fn = parts[parts.length - 1];
  const pat = fn.replace(/[0-9a-fA-F]{6,}/g, "#").replace(/\d+/g, "#").slice(0, 80);
  const dot = fn.lastIndexOf(".");
  const ext = dot > 0 && fn.length - dot <= 10 ? fn.slice(dot).toLowerCase() : "(none)";
  const l1 = parts.length > 1 ? parts[0] + "/" : "(root)";
  let n1 = agg.nodes.get(l1);
  if (!n1) agg.nodes.set(l1, (n1 = newNode()));
  bump(n1, size, lm, ext, pat);
  if (parts.length > 2) {
    const l2 = parts[0] + "/" + parts[1] + "/";
    let n2 = n1.c.get(l2);
    if (!n2) n1.c.set(l2, (n2 = newNode()));
    bump(n2, size, lm, ext, pat);
  }
  agg.largest.push([size, key, lm]);
  if (agg.largest.length > 400) {
    agg.largest.sort((a, b) => b[0] - a[0]);
    agg.largest.length = 12;
  }
}

function serNode(name, node, withKids) {
  const out = {
    p: name,
    n: node.n,
    b: node.b,
    o: node.o,
    w: node.w,
    x: [...node.ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    f: [...node.fam.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 6).map(([p, c]) => [p, c[0], c[1]]),
  };
  if (withKids && node.c.size) {
    const kids = [...node.c.entries()].sort((a, b) => b[1].b - a[1].b);
    out.c = kids.slice(0, 30).map(([k, v]) => serNode(k, v, false));
    if (kids.length > 30) {
      let rn = 0, rb = 0;
      for (const [, v] of kids.slice(30)) {
        rn += v.n;
        rb += v.b;
      }
      out.c.push({ p: `(${kids.length - 30} more)`, n: rn, b: rb, o: "", w: "", x: [], f: [] });
    }
  }
  return out;
}

function serialize(agg, bucket) {
  agg.largest.sort((a, b) => b[0] - a[0]);
  const prefs = [...agg.nodes.entries()].sort((a, b) => b[1].b - a[1].b);
  return {
    bucket,
    n: agg.n,
    b: agg.b,
    largest: agg.largest.slice(0, 12).map(([s, k, d]) => [k, s, d]),
    prefixes: prefs.slice(0, 40).map(([k, v]) => serNode(k, v, true)),
  };
}

// ---------------------------------------------------------------- walker

const SPLIT_DEPTH = 4; // below this, stream flat
const KID_LIMIT = 1500; // folder explosion guard at the bucket root
const KID_SPLIT_MAX = 64; // deeper levels: more folders than this means a
// partitioned layout (dt=2025-03-21/ style); one stream beats 10,000 spawns
const PAGE_CAP = 50000; // max entries to hold from one delimiter listing

async function walk(bucket, region, prefix, depth, agg) {
  if (depth >= SPLIT_DEPTH) return flat(bucket, region, prefix, agg);
  let res;
  try {
    res = await run(
      [
        "s3api", "list-objects-v2",
        "--bucket", bucket,
        "--prefix", prefix,
        "--delimiter", "/",
        "--max-items", String(PAGE_CAP),
      ],
      { region }
    );
  } catch (e) {
    // fall back to a flat stream on any listing hiccup
    return flat(bucket, region, prefix, agg);
  }
  const kids = (res.CommonPrefixes || []).map((p) => p.Prefix);
  const kidCap = depth === 0 ? KID_LIMIT : KID_SPLIT_MAX;
  if (res.NextToken || kids.length > kidCap) {
    // too big or too many folders at this level: stream the whole subtree
    // (nothing from this listing was merged, so no double counting)
    return flat(bucket, region, prefix, agg);
  }
  for (const o of res.Contents || []) {
    aggAdd(agg, o.Key, o.Size, String(o.LastModified).slice(0, 10));
  }
  await Promise.all(kids.map((k) => walk(bucket, region, k, depth + 1, agg)));
}

async function flat(bucket, region, prefix, agg) {
  await streamLs(`s3://${bucket}/${prefix}`, region, (d, s, k) => aggAdd(agg, k, s, d));
}

async function sweepBucket(bucket, region) {
  const agg = newAgg();
  await walk(bucket, region, "", 0, agg);
  return serialize(agg, bucket);
}

module.exports = { discoverBuckets, estimate, sweepBucket, STORAGE_PRICES };

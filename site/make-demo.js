#!/usr/bin/env node
"use strict";
// Renders site/demo.html: a real Bucket List report (lib/render.js) over a
// fictional account, so the landing page can embed a working drill-down and
// search without publishing anyone's bucket names. Forced dark to match the page.
//   node site/make-demo.js
const fs = require("fs");
const path = require("path");
const { render } = require("../lib/render");

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const GB = 1024 ** 3;

// folder(name, objects, bytes, oldest, newest, [[ext, share]], [[family, share]], kids)
function folder(p, n, b, o, w, exts, fams, kids) {
  const node = {
    p, n, b: Math.round(b), o, w,
    x: exts.map(([e, s]) => [e, Math.round(b * s)]),
    f: fams.map(([pat, s]) => [pat, Math.max(1, Math.round(n * s)), Math.round(b * s)]),
  };
  if (kids) node.c = kids;
  return node;
}
// spread a parent across child folders with plausible variation
function kidsOf(prefix, names, n, b, o, w, exts, fams) {
  const weights = names.map(() => 0.4 + rnd());
  const tot = weights.reduce((a, x) => a + x, 0);
  return names
    .map((nm, i) => folder(prefix + nm + "/", Math.round((n * weights[i]) / tot), (b * weights[i]) / tot, o, w, exts, fams))
    .sort((a, c) => c.b - a.b);
}
function largest(prefix, names, base, d) {
  return names.map((k, i) => [prefix + k, Math.round(base * (1 - i * 0.07)), d]);
}
function bucket(name, prefixes, big, region = "us-east-1") {
  return {
    bucket: name, region,
    n: prefixes.reduce((a, p) => a + p.n, 0),
    b: prefixes.reduce((a, p) => a + p.b, 0),
    largest: big,
    prefixes: prefixes.sort((a, c) => c.b - a.b),
  };
}
const months = (y, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${y}-${String(from + i).padStart(2, "0")}`);

const results = [
  bucket("acme-media-uploads", [
    folder("uploads/", 1480000, 1210 * GB, "2021-03-02", "2026-10-14", [[".jpg", 0.46], [".mp4", 0.38], [".png", 0.1]], [["IMG_#.jpg", 0.41], ["#.mp4", 0.22], ["upload-#.png", 0.09]],
      kidsOf("uploads/", ["2021", "2022", "2023", "2024", "2025", "2026"], 1480000, 1210 * GB, "2021-03-02", "2026-10-14", [[".jpg", 0.46], [".mp4", 0.38]], [["IMG_#.jpg", 0.41]])),
    folder("transcodes/", 410000, 520 * GB, "2022-01-11", "2026-10-14", [[".m3u8", 0.02], [".ts", 0.95]], [["segment_#.ts", 0.93], ["playlist.m3u8", 0.02]],
      kidsOf("transcodes/", ["1080p", "720p", "480p", "hls-audio"], 410000, 520 * GB, "2022-01-11", "2026-10-14", [[".ts", 0.95]], [["segment_#.ts", 0.93]])),
    folder("thumbnails/", 1320000, 41 * GB, "2021-03-02", "2026-10-14", [[".webp", 0.9], [".jpg", 0.1]], [["#_#x#.webp", 0.88], ["#_poster.jpg", 0.1]],
      kidsOf("thumbnails/", ["small", "medium", "large"], 1320000, 41 * GB, "2021-03-02", "2026-10-14", [[".webp", 0.9]], [["#_#x#.webp", 0.88]])),
  ], largest("uploads/2025/", ["keynote-full-4k.mp4", "launch-event-raw.mp4", "office-tour-4k.mp4", "conf-day2.mp4", "conf-day1.mp4", "brand-reel-master.mov", "webinar-0412.mp4", "webinar-0318.mp4", "townhall-q2.mp4", "townhall-q1.mp4", "demo-recording.mp4", "interview-cut3.mp4"], 38 * GB, "2025-09-18")),

  bucket("acme-data-lake", [
    folder("events/", 612000, 388 * GB, "2023-06-01", "2026-10-15", [[".parquet", 0.98], [".json", 0.01]], [["part-#-#.c#.snappy.parquet", 0.97], ["_SUCCESS", 0.01]],
      kidsOf("events/", ["clicks", "pageviews", "checkout", "search", "signup", "errors"], 612000, 388 * GB, "2023-06-01", "2026-10-15", [[".parquet", 0.98]], [["part-#-#.c#.snappy.parquet", 0.97]])),
    folder("warehouse/", 88000, 214 * GB, "2023-06-01", "2026-10-15", [[".parquet", 0.94], [".avro", 0.05]], [["part-#.parquet", 0.9], ["manifest-#.avro", 0.05]],
      kidsOf("warehouse/", ["orders", "customers", "inventory", "invoices", "shipments"], 88000, 214 * GB, "2023-06-01", "2026-10-15", [[".parquet", 0.94]], [["part-#.parquet", 0.9]])),
    folder("raw/", 196000, 61 * GB, "2023-05-20", "2026-10-15", [[".gz", 0.92], [".csv", 0.07]], [["export_#_#.csv.gz", 0.9]],
      kidsOf("raw/", ["crm", "billing", "support", "web"], 196000, 61 * GB, "2023-05-20", "2026-10-15", [[".gz", 0.92]], [["export_#_#.csv.gz", 0.9]])),
  ], largest("warehouse/orders/", ["part-00000.parquet", "part-00001.parquet", "part-00002.parquet", "part-00003.parquet", "part-00004.parquet", "part-00005.parquet", "part-00006.parquet", "part-00007.parquet", "part-00008.parquet", "part-00009.parquet", "part-00010.parquet", "part-00011.parquet"], 1.9 * GB, "2026-10-15")),

  bucket("acme-db-backups", [
    folder("postgres/", 2900, 980 * GB, "2023-01-01", "2026-10-15", [[".gz", 1]], [["prod-#-#.sql.gz", 0.97]],
      kidsOf("postgres/", ["daily", "weekly", "monthly"], 2900, 980 * GB, "2023-01-01", "2026-10-15", [[".gz", 1]], [["prod-#-#.sql.gz", 0.97]])),
    folder("redis/", 1100, 36 * GB, "2024-02-01", "2026-10-15", [[".rdb", 1]], [["dump-#.rdb", 1]]),
  ], largest("postgres/monthly/", ["prod-2026-10-01.sql.gz", "prod-2026-09-01.sql.gz", "prod-2026-08-01.sql.gz", "prod-2026-07-01.sql.gz", "prod-2026-06-01.sql.gz", "prod-2026-05-01.sql.gz", "prod-2026-04-01.sql.gz", "prod-2026-03-01.sql.gz", "prod-2026-02-01.sql.gz", "prod-2026-01-01.sql.gz", "prod-2025-12-01.sql.gz", "prod-2025-11-01.sql.gz"], 41 * GB, "2026-10-01")),

  bucket("acme-logs-archive", [
    folder("AWSLogs/", 2860000, 148 * GB, "2022-04-09", "2026-10-15", [[".gz", 1]], [["#_CloudTrail_us-east-#_#T#Z_#.json.gz", 0.96]],
      kidsOf("AWSLogs/", ["CloudTrail", "elasticloadbalancing", "vpcflowlogs"], 2860000, 148 * GB, "2022-04-09", "2026-10-15", [[".gz", 1]], [["#_CloudTrail_us-east-#_#T#Z_#.json.gz", 0.96]])),
    folder("app/", 540000, 62 * GB, "2023-08-14", "2026-10-15", [[".gz", 0.99]], [["api-#.log.gz", 0.6], ["worker-#.log.gz", 0.39]],
      kidsOf("app/", months(2026, 1, 9).map((m) => m), 540000, 62 * GB, "2023-08-14", "2026-10-15", [[".gz", 0.99]], [["api-#.log.gz", 0.6]])),
  ], largest("app/", ["2026-03/api-incident-dump.log.gz", "2025-11/worker-backfill.log.gz", "2026-07/api-0712.log.gz", "2026-07/api-0711.log.gz", "2026-06/api-0630.log.gz", "2026-05/api-0529.log.gz", "2026-04/api-0418.log.gz", "2026-02/api-0214.log.gz", "2026-01/api-0131.log.gz", "2025-12/api-1224.log.gz", "2025-10/api-1031.log.gz", "2025-09/api-0930.log.gz"], 2.4 * GB, "2026-07-12")),

  bucket("acme-ml-artifacts", [
    folder("checkpoints/", 6400, 312 * GB, "2024-09-03", "2026-10-11", [[".safetensors", 0.88], [".pt", 0.11]], [["model-#-of-#.safetensors", 0.86], ["optimizer.pt", 0.1]],
      kidsOf("checkpoints/", ["ranker-v3", "ranker-v4", "embedder-base", "embedder-large"], 6400, 312 * GB, "2024-09-03", "2026-10-11", [[".safetensors", 0.88]], [["model-#-of-#.safetensors", 0.86]])),
    folder("datasets/", 21000, 96 * GB, "2024-08-20", "2026-09-30", [[".jsonl", 0.7], [".parquet", 0.3]], [["shard-#.jsonl", 0.68], ["train-#.parquet", 0.3]],
      kidsOf("datasets/", ["clicks-2025", "queries-2026", "labels-v2"], 21000, 96 * GB, "2024-08-20", "2026-09-30", [[".jsonl", 0.7]], [["shard-#.jsonl", 0.68]])),
    folder("eval/", 3100, 1.2 * GB, "2024-09-10", "2026-10-11", [[".json", 0.8], [".csv", 0.2]], [["run-#.json", 0.78]]),
  ], largest("checkpoints/embedder-large/", ["step-120000/model-00001-of-00004.safetensors", "step-120000/model-00002-of-00004.safetensors", "step-120000/model-00003-of-00004.safetensors", "step-90000/model-00001-of-00004.safetensors", "step-90000/model-00002-of-00004.safetensors", "step-90000/model-00003-of-00004.safetensors", "step-60000/model-00001-of-00004.safetensors", "step-60000/model-00002-of-00004.safetensors", "step-60000/model-00003-of-00004.safetensors", "step-30000/model-00001-of-00004.safetensors", "step-30000/model-00002-of-00004.safetensors", "step-30000/model-00003-of-00004.safetensors"], 4.8 * GB, "2026-10-11")),

  bucket("acme-legacy-exports", [
    folder("exports/", 17600, 33 * GB, "2019-02-11", "2022-06-30", [[".zip", 0.81], [".csv", 0.19]], [["export_#.zip", 0.8], ["report_#.csv", 0.18]],
      kidsOf("exports/", ["2019", "2020", "2021", "2022"], 17600, 33 * GB, "2019-02-11", "2022-06-30", [[".zip", 0.81]], [["export_#.zip", 0.8]])),
  ], largest("exports/2021/", ["full-export-q4.zip", "full-export-q3.zip", "full-export-q2.zip", "full-export-q1.zip", "accounts-snapshot.zip", "ledger-2021.zip", "ledger-2020.zip", "ledger-2019.zip", "crm-dump.zip", "tickets.zip", "assets-manifest.csv", "users.csv"], 1.1 * GB, "2021-12-31")),

  bucket("acme-web-assets", [
    folder("static/", 4100, 2.3 * GB, "2022-11-01", "2026-10-14", [[".js", 0.42], [".woff2", 0.2], [".css", 0.08]], [["main.#.js", 0.3], ["chunk-#.js", 0.12]],
      kidsOf("static/", ["js", "css", "fonts", "img"], 4100, 2.3 * GB, "2022-11-01", "2026-10-14", [[".js", 0.42]], [["chunk-#.js", 0.12]])),
    folder("(root)", 6, 140000, "2022-11-01", "2026-10-14", [[".html", 0.6], [".txt", 0.1]], [["index.html", 0.4]]),
  ], largest("static/img/", ["hero-video-poster.png", "og-image.png", "team-photo.jpg", "pricing-illustration.png", "office.jpg", "logo-sheet.png", "screenshot-dashboard.png", "screenshot-mobile.png", "feature-1.png", "feature-2.png", "feature-3.png", "favicon-512.png"], 6.2 * 1024 ** 2, "2026-06-02")),

  bucket("acme-terraform-state", [
    folder("env/", 44, 3.1 * 1024 ** 2, "2022-08-15", "2026-10-13", [[".tfstate", 1]], [["terraform.tfstate", 1]]),
  ], largest("env/", ["prod/terraform.tfstate", "staging/terraform.tfstate", "dev/terraform.tfstate"], 900000, "2026-10-13")),
];

const price = { StandardStorage: 0.023, StandardIAStorage: 0.0125, GlacierInstantRetrievalStorage: 0.004, GlacierStorage: 0.0036, DeepArchiveStorage: 0.00099 };
const mix = {
  "acme-media-uploads": { StandardStorage: 0.62, StandardIAStorage: 0.38 },
  "acme-data-lake": { StandardStorage: 0.55, GlacierInstantRetrievalStorage: 0.45 },
  "acme-db-backups": { DeepArchiveStorage: 0.9, StandardStorage: 0.1 },
  "acme-logs-archive": { GlacierStorage: 0.8, StandardIAStorage: 0.2 },
  "acme-ml-artifacts": { StandardStorage: 1 },
  "acme-legacy-exports": { StandardIAStorage: 1 },
  "acme-web-assets": { StandardStorage: 1 },
  "acme-terraform-state": { StandardStorage: 1 },
};
const stats = new Map();
for (const r of results) {
  const hidden = r.bucket === "acme-db-backups" ? 41800 : 0; // versioned backups: old versions linger
  const classes = {};
  let estMonthly = 0;
  const totGB = (r.b / GB) * (r.bucket === "acme-db-backups" ? 2.6 : 1);
  for (const [t, s] of Object.entries(mix[r.bucket])) {
    classes[t] = totGB * s;
    estMonthly += totGB * s * price[t];
  }
  stats.set(r.bucket, { cwObjects: r.n + hidden, classes, estMonthly });
}

const notes = {};
let html = render({ results, stats, notes, account: "123456789012" });
// force the dark palette regardless of the visitor's OS setting
const dark = /@media \(prefers-color-scheme: dark\) \{ (:root \{[^}]*\}) \}/.exec(html)[1];
html = html.replace("</style>", "  " + dark + "\n</style>");
fs.writeFileSync(path.join(__dirname, "demo.html"), html);
console.log("wrote site/demo.html", html.length, "bytes");

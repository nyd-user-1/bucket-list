#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync, spawn } = require("child_process");
const { run, setConcurrency } = require("../lib/aws");
const { discoverBuckets, estimate, sweepBucket } = require("../lib/sweep");
const { render } = require("../lib/render");

const VERSION = require("../package.json").version;

const HELP = `Bucket List ${VERSION} — lightweight search for S3

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
It reads names and sizes only; no object is ever downloaded or modified.`;

function parseArgs(argv) {
  const a = { output: "bucket-list.html", buckets: null, notes: null, concurrency: 12, yes: false, open: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--help" || v === "-h") { console.log(HELP); process.exit(0); }
    else if (v === "--version") { console.log(VERSION); process.exit(0); }
    else if (v === "--yes" || v === "-y") a.yes = true;
    else if (v === "--open") a.open = true;
    else if (v === "--output") a.output = argv[++i];
    else if (v === "--buckets") a.buckets = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--notes") a.notes = argv[++i];
    else if (v === "--concurrency") a.concurrency = parseInt(argv[++i], 10) || 12;
    else { console.error(`unknown option: ${v} (try --help)`); process.exit(2); }
  }
  return a;
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}

function fmtBytes(b) {
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(0) + " MB";
  if (b < 1024 ** 4) return (b / 1024 ** 3).toFixed(1) + " GB";
  return (b / 1024 ** 4).toFixed(2) + " TB";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  setConcurrency(args.concurrency);

  // 0. preconditions
  const cliCheck = spawnSync("aws", ["--version"], { encoding: "utf8" });
  if (cliCheck.error) {
    console.error("The AWS CLI was not found. Install it and run `aws configure`, then retry.");
    process.exit(1);
  }
  let account = "";
  try {
    const ident = await run(["sts", "get-caller-identity"]);
    account = ident.Account || "";
  } catch (e) {
    console.error("AWS credentials aren't working: " + e.message);
    console.error("Run `aws configure` (or set your profile/SSO session) and retry.");
    process.exit(1);
  }

  // 1. discovery
  process.stderr.write(`Discovering buckets in account ${account}...\n`);
  const { buckets, skipped } = await discoverBuckets(args.buckets);
  for (const s of skipped) process.stderr.write(`  skipping ${s.name}: no access to its region/location\n`);
  if (!buckets.length) {
    console.error("No buckets to sweep.");
    process.exit(1);
  }

  // 2. estimate + guardrail
  const stats = await estimate(buckets);
  let estObjects = 0;
  let estBytes = 0;
  for (const b of buckets) {
    const s = stats.get(b.name);
    estObjects += s.cwObjects || 0;
    estBytes += Object.values(s.classes).reduce((a, gb) => a + gb, 0) * 1024 ** 3;
  }
  const estRequests = Math.ceil((estObjects / 1000) * 1.2) + buckets.length * 3;
  const estCost = (estRequests / 1000) * 0.005;
  const estMinutes = Math.max(1, Math.round((estRequests * 0.12) / args.concurrency / 60));
  process.stderr.write(
    `${buckets.length} buckets, ~${estObjects.toLocaleString("en-US")} objects, ~${fmtBytes(estBytes)} (CloudWatch estimate).\n` +
    `Sweep will make ~${estRequests.toLocaleString("en-US")} LIST requests: ~$${estCost < 0.005 ? "0.01" : estCost.toFixed(2)}, roughly ${estMinutes} min.\n`
  );
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error("Not a terminal; re-run with --yes to proceed without confirmation.");
      process.exit(1);
    }
    const ok = await confirm("Proceed? [y/N] ");
    if (!ok) {
      console.error("Aborted. Nothing was swept.");
      process.exit(0);
    }
  }

  // 3. sweep
  const t0 = Date.now();
  const results = [];
  let done = 0;
  await Promise.all(
    buckets.map(async (b) => {
      try {
        const r = await sweepBucket(b.name, b.region);
        r.region = b.region;
        results.push(r);
      } catch (e) {
        process.stderr.write(`  ${b.name}: FAILED (${e.message})\n`);
        results.push({ bucket: b.name, region: b.region, n: 0, b: 0, largest: [], prefixes: [] });
      }
      done++;
      process.stderr.write(`  [${done}/${buckets.length}] ${b.name}\n`);
    })
  );

  // 4. annotations
  let notes = {};
  const notesPath = args.notes || (fs.existsSync("bucket-list.notes.json") ? "bucket-list.notes.json" : null);
  if (notesPath) {
    try {
      notes = JSON.parse(fs.readFileSync(notesPath, "utf8"));
      process.stderr.write(`Annotations loaded from ${notesPath}.\n`);
    } catch (e) {
      process.stderr.write(`Could not read ${notesPath}: ${e.message} (continuing without annotations)\n`);
    }
  }

  // 5. render
  const html = render({ results, stats, notes, account });
  const out = path.resolve(args.output);
  fs.writeFileSync(out, html);
  const totalN = results.reduce((a, r) => a + r.n, 0);
  const totalB = results.reduce((a, r) => a + r.b, 0);
  const secs = Math.round((Date.now() - t0) / 1000);
  process.stderr.write(
    `\nSwept ${totalN.toLocaleString("en-US")} objects (${fmtBytes(totalB)}) across ${results.length} buckets in ${secs}s.\n`
  );
  console.log(out);

  if (args.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [out], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

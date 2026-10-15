#!/usr/bin/env node
"use strict";
// Bucket List app server: a zero-dependency local HTTP server that drives the
// shared engine (../lib, the same code the npm CLI runs) and serves the UI.
// The native shell (shell/bucket-list-shell.swift) launches it as a child
// process; `bin/bucket-list-app --browser` runs it standalone.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// In the repo the engine is ../lib; inside the .app bundle it sits beside us.
const LIB = fs.existsSync(path.join(__dirname, "lib", "sweep.js")) ? path.join(__dirname, "lib") : path.join(__dirname, "..", "lib");
const { run, setConcurrency } = require(path.join(LIB, "aws"));
const { discoverBuckets, estimate, sweepBucket } = require(path.join(LIB, "sweep"));
const { render } = require(path.join(LIB, "render"));

const PORT = parseInt(process.env.BUCKET_LIST_PORT || "3011", 10);
const HOST = process.env.HOSTNAME || "127.0.0.1";
const CONCURRENCY = parseInt(process.env.BUCKET_LIST_CONCURRENCY || "12", 10) || 12;
const UI = path.join(__dirname, "ui", "index.html");
setConcurrency(CONCURRENCY);

// One sweep at a time; the UI polls /api/status.
const state = {
  account: "",
  buckets: [], // [{name, region}] from the last discovery
  stats: new Map(), // CloudWatch estimate per bucket
  job: null, // {state, selected, perBucket, startedAt, finishedAt, error}
  report: null, // {html, generatedAt, n, b, buckets}
};

// ------------------------------------------------------------- handlers

async function check() {
  const v = spawnSync("aws", ["--version"], { encoding: "utf8" });
  if (v.error) return { ok: false, cli: false, problem: "cli-missing", detail: "The AWS CLI was not found on this Mac's PATH." };
  const version = ((v.stdout || "") + (v.stderr || "")).trim().split(/\s+/)[0] || "";
  try {
    const ident = await run(["sts", "get-caller-identity"]);
    state.account = ident.Account || "";
    return { ok: true, cli: true, version, account: state.account, arn: ident.Arn || "" };
  } catch (e) {
    return { ok: false, cli: true, version, problem: "credentials", detail: e.message };
  }
}

async function discover() {
  const c = await check();
  if (!c.ok) return c;
  const { buckets, skipped } = await discoverBuckets(null);
  const stats = buckets.length ? await estimate(buckets) : new Map();
  state.buckets = buckets;
  state.stats = stats;
  return {
    ok: true,
    account: state.account,
    buckets: buckets.map((b) => {
      const s = stats.get(b.name) || { cwObjects: 0, classes: {}, estMonthly: 0 };
      const gb = Object.values(s.classes).reduce((a, x) => a + x, 0);
      return { name: b.name, region: b.region, objects: s.cwObjects, bytes: Math.round(gb * 1024 ** 3), monthly: s.estMonthly };
    }),
    skipped: skipped.map((s) => s.name),
    concurrency: CONCURRENCY,
    lastSelection: state.job ? state.job.selected : null,
  };
}

function startSweep(names) {
  if (state.job && state.job.state === "running") return { ok: false, error: "A sweep is already running." };
  const known = new Map(state.buckets.map((b) => [b.name, b]));
  const selected = (names || []).filter((n) => known.has(n));
  if (!selected.length) return { ok: false, error: "No buckets selected." };
  const job = {
    state: "running",
    selected,
    perBucket: Object.fromEntries(selected.map((n) => [n, { state: "sweeping", n: 0, b: 0 }])),
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  state.job = job;
  (async () => {
    const results = [];
    await Promise.all(
      selected.map(async (name) => {
        const b = known.get(name);
        const pb = job.perBucket[name];
        try {
          const r = await sweepBucket(b.name, b.region);
          r.region = b.region;
          results.push(r);
          Object.assign(pb, { state: "done", n: r.n, b: r.b });
        } catch (e) {
          results.push({ bucket: b.name, region: b.region, n: 0, b: 0, largest: [], prefixes: [] });
          Object.assign(pb, { state: "failed", error: e.message });
        }
      })
    );
    const html = render({ results, stats: state.stats, notes: loadNotes(), account: state.account });
    state.report = {
      html,
      generatedAt: Date.now(),
      n: results.reduce((a, r) => a + r.n, 0),
      b: results.reduce((a, r) => a + r.b, 0),
      buckets: results.length,
    };
    job.state = "done";
    job.finishedAt = Date.now();
  })().catch((e) => {
    job.state = "failed";
    job.error = e.message || String(e);
    job.finishedAt = Date.now();
  });
  return { ok: true };
}

// Optional annotations, same format as the CLI's bucket-list.notes.json.
function loadNotes() {
  const p = process.env.BUCKET_LIST_NOTES || path.join(os.homedir(), ".bucket-list", "notes.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function status() {
  const j = state.job;
  return {
    now: Date.now(),
    account: state.account,
    job: j && { state: j.state, selected: j.selected, perBucket: j.perBucket, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error },
    report: state.report && { generatedAt: state.report.generatedAt, n: state.report.n, b: state.report.b, buckets: state.report.buckets },
  };
}

// ------------------------------------------------------------- http

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function exportName() {
  const d = new Date(state.report.generatedAt);
  const p = (x) => String(x).padStart(2, "0");
  return `bucket-list-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.html`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, fs.readFileSync(UI), { "Content-Type": "text/html; charset=utf-8" });
    }
    if (req.method === "GET" && url.pathname === "/api/check") return json(res, 200, await check());
    if (req.method === "POST" && url.pathname === "/api/discover") return json(res, 200, await discover());
    if (req.method === "POST" && url.pathname === "/api/sweep") {
      const body = await readBody(req);
      const r = startSweep(body.buckets || (state.job && state.job.selected));
      return json(res, r.ok ? 202 : 409, r);
    }
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, status());
    if (req.method === "GET" && (url.pathname === "/report" || url.pathname === "/export")) {
      if (!state.report) return send(res, 404, "No report yet.", { "Content-Type": "text/plain" });
      const h = { "Content-Type": "text/html; charset=utf-8" };
      if (url.pathname === "/export") h["Content-Disposition"] = `attachment; filename="${exportName()}"`;
      return send(res, 200, state.report.html, h);
    }
    send(res, 404, "Not found", { "Content-Type": "text/plain" });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`Bucket List app server on http://localhost:${PORT}/\n`);
});

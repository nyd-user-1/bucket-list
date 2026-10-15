"use strict";
// Thin wrappers around the AWS CLI. No SDK, no dependencies: if `aws` works in
// the user's terminal, Bucket List works, regardless of what else they use.
const { spawn } = require("child_process");

let MAX = 12;
let active = 0;
const queue = [];

function setConcurrency(n) {
  MAX = Math.max(1, n | 0);
}

function acquire() {
  return new Promise((res) => {
    if (active < MAX) {
      active++;
      res();
    } else {
      queue.push(res);
    }
  });
}

function release() {
  active--;
  if (queue.length) {
    active++;
    queue.shift()();
  }
}

/** Run an aws CLI command, return parsed JSON (or raw text with json:false). */
async function run(args, { json = true, region = null } = {}) {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const full = [...args];
      if (json) full.push("--output", "json");
      if (region) full.push("--region", region);
      const p = spawn("aws", full, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.setEncoding("utf8");
      p.stderr.setEncoding("utf8");
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code !== 0) {
          return reject(new Error(`aws ${args.slice(0, 3).join(" ")} failed: ${err.trim().slice(0, 300) || "exit " + code}`));
        }
        if (!json) return resolve(out);
        try {
          resolve(out.trim() ? JSON.parse(out) : {});
        } catch (e) {
          reject(new Error(`bad JSON from aws ${args[0]} ${args[1]}: ${e.message}`));
        }
      });
    });
  } finally {
    release();
  }
}

/**
 * Stream `aws s3 ls <url> --recursive` line by line.
 * Calls onObject(dateYYYYMMDD, sizeBytes, key) per object. Constant memory,
 * works for millions of objects.
 */
async function streamLs(s3url, region, onObject) {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const args = ["s3", "ls", s3url, "--recursive"];
      if (region) args.push("--region", region);
      const p = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let err = "";
      const RE = /^(\d{4}-\d{2}-\d{2}) +\S+ +(\d+) (.*)$/;
      p.stdout.setEncoding("utf8");
      p.stderr.setEncoding("utf8");
      p.stdout.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const m = RE.exec(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (m) onObject(m[1], parseInt(m[2], 10), m[3]);
        }
      });
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => {
        // `aws s3 ls` exits 1 on an empty prefix with no stderr — that's fine.
        if (code !== 0 && err.trim()) {
          return reject(new Error(`aws s3 ls ${s3url} failed: ${err.trim().slice(0, 300)}`));
        }
        resolve();
      });
    });
  } finally {
    release();
  }
}

module.exports = { run, streamLs, setConcurrency };

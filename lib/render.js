"use strict";
// Renders the sweep into a single self-contained HTML file:
// hash-routed pages (catalog -> bucket -> folder), search, chart, dark mode.

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CHIP = { keep: ["keep", "Keep"], review: ["review", "Review"], disposable: ["disp", "Disposable"], empty: ["disp", "Empty"] };

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtB(b) {
  if (b <= 0) return "0";
  if (b < 1024) return b + " B";
  if (b < 1024 ** 2) return Math.round(b / 1024) + " KB";
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + " MB";
  return b < 100 * 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + " GB" : Math.round(b / 1024 ** 3) + " GB";
}
function fmtN(n) {
  return n.toLocaleString("en-US");
}
function fmtD(d, thisYear) {
  if (!d || d === "9999") return "";
  const y = d.slice(0, 4), m = parseInt(d.slice(5, 7), 10), dd = parseInt(d.slice(8, 10), 10);
  const base = MONTHS[m] + " " + dd;
  return y === thisYear ? base : base + ", " + y;
}
function fmtWin(o, w, thisYear) {
  const fo = fmtD(o, thisYear), fw = fmtD(w, thisYear);
  if (!fo && !fw) return "–";
  return fo === fw ? fo : fo + " – " + fw;
}
function fmtUsd(u) {
  if (u >= 0.01) return u.toFixed(2);
  return u > 0 ? "&lt;0.01" : "0";
}
function mostly(node) {
  const bits = (node.x || []).slice(0, 2).filter(([, bb]) => bb > 0).map(([e, bb]) => esc(e) + " " + fmtB(bb));
  return bits.length ? bits.join(" · ") : "–";
}
function chip(v) {
  const c = CHIP[v];
  return c ? '<span class="chip ' + c[0] + '"><span class="dot"></span>' + c[1] + "</span>" : "";
}

const CSS_VARS = [
  "  :root { color-scheme: light; --page:#f9f9f7; --surface-1:#fcfcfb; --text-1:#0b0b0b; --text-2:#52514e; --muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,0.10); --series-1:#2a78d6; --good:#0ca30c; --warn:#fab219; --chip-keep-bg:rgba(12,163,12,0.10); --chip-review-bg:rgba(250,178,25,0.16); --chip-disp-bg:rgba(137,135,129,0.14); }",
  "  @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --page:#0d0d0d; --surface-1:#1a1a19; --text-1:#f0efec; --text-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,0.10); --series-1:#3987e5; --good:#0ca30c; --warn:#fab219; --chip-keep-bg:rgba(12,163,12,0.16); --chip-review-bg:rgba(250,178,25,0.14); --chip-disp-bg:rgba(137,135,129,0.18); } }",
].join("\n");

const CSS = [
  "  * { box-sizing: border-box; }",
  '  body { margin: 0; background: var(--page); color: var(--text-1); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 28px 20px 48px; }',
  "  .wrap { max-width: 1060px; margin: 0 auto; }",
  "  h1 { font-size: 21px; font-weight: 650; margin: 0 0 2px; }",
  "  .meta { color: var(--muted); font-size: 13px; margin-bottom: 26px; }",
  "  .toprow { display: flex; gap: 14px; flex-wrap: wrap; align-items: stretch; margin-bottom: 14px; }",
  "  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }",
  "  .hero { flex: 1 1 240px; display: flex; flex-direction: column; justify-content: center; }",
  "  .hero .label { font-size: 13px; color: var(--text-2); }",
  "  .hero .value { font-size: 52px; font-weight: 650; line-height: 1.1; letter-spacing: -0.5px; }",
  "  .hero .sub { font-size: 13px; color: var(--muted); margin-top: 4px; }",
  "  .tiles { flex: 2 1 420px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }",
  "  .tile { display: flex; flex-direction: column; justify-content: center; }",
  "  .tile .label { font-size: 12.5px; color: var(--text-2); }",
  "  .tile .value { font-size: 26px; font-weight: 650; margin-top: 2px; }",
  "  .tile .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }",
  "  .chart { margin-bottom: 14px; }",
  "  .chart h2, .tablecard h2 { font-size: 15px; font-weight: 650; margin: 0 0 2px; }",
  "  .chart .sub, .tablecard .sub { font-size: 12.5px; color: var(--muted); margin: 0 0 14px; }",
  "  .chart h2 { margin-bottom: 12px; }",
  "  .barrow { display: grid; grid-template-columns: 1fr 64px; align-items: center; gap: 10px; padding: 3px 0; border-radius: 6px; }",
  "  .barrow:hover { background: rgba(42,120,214,0.07); }",
  "  .track { position: relative; height: 14px; }",
  "  .bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 2px; }",
  "  .bar.other { opacity: 0.45; }",
  "  .barrow .val { font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }",
  "  .axisline { border-left: 1px solid var(--baseline); position: absolute; top: 0; bottom: 0; left: 0; }",
  "  .tablecard { padding: 18px 0 6px; margin-bottom: 14px; }",
  "  .tablecard h2, .tablecard .sub { padding: 0 20px; }",
  "  table { width: 100%; border-collapse: collapse; font-size: 13px; }",
  "  th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }",
  "  td { padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }",
  "  tr:last-child td { border-bottom: none; }",
  "  tbody tr:hover { background: rgba(42,120,214,0.05); }",
  "  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }",
  "  td.bname { font-weight: 600; white-space: nowrap; }",
  "  td.bname .proj { display: block; font-weight: 400; font-size: 11.5px; color: var(--muted); }",
  "  td.contents { color: var(--text-2); font-size: 12.5px; max-width: 300px; }",
  "  td.contents .note { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }",
  "  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }",
  "  .chip.keep { background: var(--chip-keep-bg); }",
  "  .chip.review { background: var(--chip-review-bg); }",
  "  .chip.disp { background: var(--chip-disp-bg); color: var(--text-2); }",
  "  .chip .dot { width: 7px; height: 7px; border-radius: 50%; }",
  "  .chip.keep .dot { background: var(--good); }",
  "  .chip.review .dot { background: var(--warn); }",
  "  .chip.disp .dot { background: var(--muted); }",
  "  .foot { color: var(--muted); font-size: 12px; margin-top: 18px; }",
  "  .firstcol { padding-left: 20px; }",
  "  .lastcol { padding-right: 20px; }",
  "  .page { display: none; }",
  "  .page.active { display: block; }",
  "  tr.rowlink { cursor: pointer; }",
  "  .chev { color: var(--muted); font-weight: 400; margin-left: 6px; }",
  "  .pagehead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 2px; }",
  "  .backbtn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-1); color: var(--text-2); text-decoration: none; font-size: 17px; line-height: 1; flex: 0 0 auto; }",
  "  .backbtn:hover { color: var(--text-1); border-color: var(--baseline); }",
  "  .tiles4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }",
  "  @media (max-width: 760px) { .tiles4 { grid-template-columns: repeat(2, 1fr); } .tiles { grid-template-columns: 1fr; } }",
  "  td.key { font-size: 12.5px; color: var(--text-2); max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  "  .crumb { font-size: 13px; color: var(--muted); margin-bottom: 14px; }",
  "  .crumb a { color: var(--text-2); text-decoration: none; }",
  "  .crumb a:hover { color: var(--text-1); }",
  "  .searchwrap { position: relative; max-width: 460px; margin: -12px 0 18px; }",
  "  .search { width: 100%; padding: 9px 12px; font: inherit; font-size: 14px; color: var(--text-1); background: var(--surface-1); border: 1px solid var(--border); border-radius: 9px; outline: none; }",
  "  .search:focus { border-color: var(--series-1); }",
  "  .search::placeholder { color: var(--muted); }",
  "  .qresults { display: none; position: absolute; top: calc(100% + 6px); left: 0; right: 0; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); max-height: 340px; overflow-y: auto; z-index: 20; }",
  "  .qitem { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; cursor: pointer; font-size: 13px; }",
  "  .qitem:hover { background: rgba(42,120,214,0.08); }",
  "  .qitem strong { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  "  .qitem span { color: var(--muted); white-space: nowrap; }",
  "  tr.hit td { background: rgba(42,120,214,0.18); }",
  "  .viztip { position: fixed; z-index: 10; background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; font-size: 12.5px; color: var(--text-1); pointer-events: none; box-shadow: 0 2px 10px rgba(0,0,0,0.15); display: none; white-space: nowrap; }",
  "  .about { font-size: 13.5px; color: var(--text-2); margin: 0; }",
].join("\n");

// Plain-string scripts (no template interpolation anywhere near user data).
const SCRIPT = [
  "<script>",
  "  function route() {",
  '    var h = location.hash.slice(1);',
  '    var target = h ? "page-" + h : "page-main";',
  '    var pages = document.querySelectorAll(".page");',
  "    var found = false;",
  "    pages.forEach(function (p) { if (p.id === target) found = true; });",
  '    if (!found) target = "page-main";',
  '    pages.forEach(function (p) { p.classList.toggle("active", p.id === target); });',
  "    window.scrollTo(0, 0);",
  "  }",
  '  window.addEventListener("hashchange", route);',
  "  route();",
  '  var tip = document.createElement("div");',
  '  tip.className = "viztip";',
  "  document.body.appendChild(tip);",
  '  document.querySelectorAll(".barrow[data-label]").forEach(function (row) {',
  '    row.addEventListener("mousemove", function (e) {',
  '      tip.textContent = row.dataset.label + "  \\u00b7  " + row.dataset.val;',
  '      tip.style.display = "block";',
  "      var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);",
  '      tip.style.left = x + "px";',
  '      tip.style.top = (e.clientY + 14) + "px";',
  "    });",
  '    row.addEventListener("mouseleave", function () { tip.style.display = "none"; });',
  "  });",
  "  (function () {",
  '    var q = document.getElementById("q"), qr = document.getElementById("qr");',
  "    if (!q) return;",
  "    var idx = [], seen = {};",
  '    document.querySelectorAll(".page").forEach(function (pg) {',
  '      var h = pg.querySelector("h1");',
  "      var title = h ? h.textContent.trim() : pg.id;",
  '      if (pg.id === "page-main") title = "All buckets";',
  '      var hash = pg.id === "page-main" ? "" : pg.id.slice(5);',
  '      pg.querySelectorAll("td.bname, td.key").forEach(function (td) {',
  '        var t = td.childNodes[0] ? td.childNodes[0].textContent.trim() : "";',
  "        if (!t) return;",
  '        var k = t + "|" + pg.id;',
  "        if (seen[k]) return;",
  "        seen[k] = 1;",
  "        idx.push({ t: t, l: t.toLowerCase(), hash: hash, title: title, row: td.parentElement });",
  "      });",
  "    });",
  "    var cur = [];",
  "    function go(e) {",
  "      location.hash = e.hash;",
  '      qr.style.display = "none";',
  "      setTimeout(function () {",
  '        e.row.classList.add("hit");',
  '        e.row.scrollIntoView({ block: "center" });',
  '        setTimeout(function () { e.row.classList.remove("hit"); }, 1800);',
  "      }, 60);",
  "    }",
  "    function render(list) {",
  '      qr.innerHTML = "";',
  "      list.slice(0, 20).forEach(function (e) {",
  '        var d = document.createElement("div");',
  '        d.className = "qitem";',
  '        var s = document.createElement("strong"); s.textContent = e.t;',
  '        var c = document.createElement("span"); c.textContent = e.title;',
  "        d.appendChild(s); d.appendChild(c);",
  '        d.addEventListener("mousedown", function (ev) { ev.preventDefault(); go(e); });',
  "        qr.appendChild(d);",
  "      });",
  '      qr.style.display = list.length ? "block" : "none";',
  "    }",
  '    q.addEventListener("input", function () {',
  "      var v = q.value.trim().toLowerCase();",
  '      if (v.length < 2) { qr.style.display = "none"; cur = []; return; }',
  "      var pre = [], sub = [];",
  "      for (var i = 0; i < idx.length; i++) {",
  "        var p = idx[i].l.indexOf(v);",
  "        if (p === 0) pre.push(idx[i]); else if (p > 0) sub.push(idx[i]);",
  "      }",
  "      cur = pre.concat(sub);",
  "      render(cur);",
  "    });",
  '    q.addEventListener("keydown", function (ev) {',
  '      if (ev.key === "Enter" && cur.length) go(cur[0]);',
  '      if (ev.key === "Escape") { q.value = ""; qr.style.display = "none"; }',
  "    });",
  '    document.addEventListener("click", function (ev) {',
  '      if (!ev.target.closest(".searchwrap")) qr.style.display = "none";',
  "    });",
  "  })();",
  "</script>",
].join("\n");

/**
 * @param results   array of serialized bucket sweeps ({bucket,n,b,largest,prefixes})
 * @param stats     Map bucket -> {cwObjects, classes, estMonthly}
 * @param notes     object bucket -> {verdict, note, project} (optional)
 * @param account   AWS account id string
 */
function render({ results, stats, notes = {}, account = "" }) {
  const now = new Date();
  const thisYear = String(now.getFullYear());
  const genDate = MONTHS[now.getMonth() + 1] + " " + now.getDate() + ", " + now.getFullYear();

  const st = (b) => stats.get(b) || { cwObjects: 0, classes: {}, estMonthly: 0 };
  const order = [...results].sort((a, c) => st(c.bucket).estMonthly - st(a.bucket).estMonthly || c.b - a.b);

  // slugs
  const slugs = new Map();
  const used = new Set();
  for (const r of order) {
    let s = r.bucket.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 50);
    while (used.has(s)) s += "x";
    used.add(s);
    slugs.set(r.bucket, s);
  }

  const totalN = order.reduce((a, r) => a + r.n, 0);
  const totalB = order.reduce((a, r) => a + r.b, 0);
  const totalMo = order.reduce((a, r) => a + st(r.bucket).estMonthly, 0);
  const regions = new Set(order.map((r) => r.region).filter(Boolean));
  const coldB = order.reduce((a, r) => {
    const c = st(r.bucket).classes;
    return a + (((c.GlacierInstantRetrievalStorage || 0) + (c.GlacierStorage || 0) + (c.DeepArchiveStorage || 0)) * 1024 ** 3);
  }, 0);
  const hiddenBuckets = order.filter((r) => {
    const h = st(r.bucket).cwObjects - r.n;
    return h > 1000 && h > r.n * 0.01;
  });

  const anyVerdict = order.some((r) => notes[r.bucket] && notes[r.bucket].verdict);
  const pages = [];

  // -------------------------------------------------------------- main page
  let rows = "";
  for (const r of order) {
    const a = notes[r.bucket] || {};
    const slug = "b-" + slugs.get(r.bucket);
    const prefs = r.prefixes.slice(0, 6).map((p) => esc(p.p));
    let contents = prefs.length ? prefs.join(" · ") : "empty";
    if (r.prefixes.length > 6) contents += " and " + (r.prefixes.length - 6) + " more";
    const noteh = a.note ? '<span class="note">' + esc(a.note) + "</span>" : "";
    rows +=
      '<tr class="rowlink" onclick="location.hash=\'' + slug + '\'">' +
      '<td class="bname firstcol">' + esc(r.bucket) + '<span class="chev">›</span>' +
      '<span class="proj">' + esc(a.project || r.region || "") + "</span></td>" +
      (anyVerdict ? "<td>" + chip(a.verdict) + "</td>" : "") +
      '<td class="num">' + fmtB(r.b) + '</td><td class="num">' + fmtN(r.n) + '</td><td class="num">' + fmtUsd(st(r.bucket).estMonthly) + "</td>" +
      '<td class="contents lastcol">' + contents + noteh + "</td></tr>";
  }

  let chartCard = "";
  const chartItems = order.filter((r) => st(r.bucket).estMonthly >= 0.01).slice(0, 12);
  if (chartItems.length >= 2) {
    const maxu = st(chartItems[0].bucket).estMonthly;
    const otherU = totalMo - chartItems.reduce((a, r) => a + st(r.bucket).estMonthly, 0);
    let bars = "";
    for (const r of chartItems) {
      const u = st(r.bucket).estMonthly;
      bars +=
        '<div class="barrow" data-label="' + esc(r.bucket) + '" data-val="$' + u.toFixed(2) + '/mo"><div class="track">' +
        '<div class="bar" style="width:' + ((u / maxu) * 100).toFixed(1) + '%"></div></div><div class="val">$' + u.toFixed(2) + "</div></div>";
    }
    if (otherU > 0.005) {
      bars +=
        '<div class="barrow" data-label="' + (order.length - chartItems.length) + ' more buckets" data-val="$' + otherU.toFixed(2) + '/mo"><div class="track">' +
        '<div class="bar other" style="width:' + ((otherU / maxu) * 100).toFixed(1) + '%"></div></div><div class="val">$' + otherU.toFixed(2) + "</div></div>";
    }
    chartCard =
      '<div class="card chart"><h2>Monthly cost by bucket</h2>' +
      '<div style="position:relative;"><div class="axisline" style="left:0;"></div>' + bars + "</div></div>";
  }

  const hero = totalMo > 0
    ? '<div class="card hero"><div class="label">S3 storage cost</div>' +
      '<div class="value">$' + (totalMo / 30).toFixed(2) + '<span style="font-size:22px;color:var(--text-2);font-weight:500;">/day</span></div>' +
      '<div class="sub">$' + totalMo.toFixed(2) + " per month, estimated at list prices</div></div>"
    : '<div class="card hero"><div class="label">Stored</div>' +
      '<div class="value">' + fmtB(totalB) + "</div>" +
      '<div class="sub">across ' + order.length + " buckets</div></div>";

  const storedTile = totalB > 0 && coldB > 0
    ? Math.round((coldB / totalB) * 100) + "% in cold storage classes"
    : "all storage classes";
  const objectsSub = hiddenBuckets.length
    ? hiddenBuckets.length + " bucket" + (hiddenBuckets.length > 1 ? "s" : "") + " also hide old versions"
    : "current versions";

  pages.push(
    '<div id="page-main" class="page">' +
    "<h1>Bucket List</h1>" +
    '<div class="meta">Lightweight search for S3</div>' +
    '<div class="searchwrap"><input id="q" class="search" type="search" placeholder="Search buckets, folders, files" autocomplete="off"><div id="qr" class="qresults"></div></div>' +
    '<div class="toprow">' + hero +
    '<div class="tiles">' +
    '<div class="card tile"><div class="label">Stored</div><div class="value">' + fmtB(totalB) + '</div><div class="sub">' + storedTile + "</div></div>" +
    '<div class="card tile"><div class="label">Objects</div><div class="value">' + (totalN >= 1e6 ? (totalN / 1e6).toFixed(1) + "M" : fmtN(totalN)) + '</div><div class="sub">' + objectsSub + "</div></div>" +
    '<div class="card tile"><div class="label">Buckets</div><div class="value">' + order.length + '</div><div class="sub">' +
    (regions.size > 1 ? "across " + regions.size + " regions" : [...regions][0] || "") + "</div></div>" +
    "</div></div>" +
    chartCard +
    '<div class="card tablecard"><h2>All ' + order.length + " buckets</h2>" +
    '<p class="sub">Every row opens a drill-down. Sorted by cost.</p>' +
    '<table><thead><tr><th class="firstcol">Bucket</th>' + (anyVerdict ? "<th>Verdict</th>" : "") +
    '<th class="num">Size</th><th class="num">Objects</th><th class="num">$/mo</th><th class="lastcol">Contents</th></tr></thead>' +
    "<tbody>" + rows + "</tbody></table></div>" +
    '<div class="foot">Full object enumeration via the AWS CLI · account ' + esc(account) + " · " + genDate +
    " · storage only at us-east-1 list prices, an estimate; request and transfer charges excluded.</div>" +
    "</div>"
  );

  // ------------------------------------------------- bucket + folder pages
  for (const r of order) {
    const a = notes[r.bucket] || {};
    const slug = "b-" + slugs.get(r.bucket);
    const bst = st(r.bucket);
    let lastW = "";
    let lastP = "";
    for (const p of r.prefixes) {
      if (p.w > lastW) {
        lastW = p.w;
        lastP = p.p;
      }
    }
    const topShare = r.b > 0 && r.prefixes.length
      ? Math.round((r.prefixes[0].b / r.b) * 100) + "% under " + esc(r.prefixes[0].p)
      : "empty";

    let prows = "";
    r.prefixes.forEach((p, i) => {
      const hasKids = !!(p.c && p.c.length);
      const pid = "p-" + slugs.get(r.bucket) + "-" + i;
      const click = hasKids ? ' class="rowlink" onclick="location.hash=\'' + pid + '\'"' : "";
      const chev = hasKids ? '<span class="chev">›</span>' : "";
      const fams = p.f || [];
      const famtxt = fams.length && fams[0][1] > 2 ? " — " + esc(fams[0][0]) + " ×" + fmtN(fams[0][1]) : "";
      prows +=
        "<tr" + click + '><td class="bname firstcol">' + esc(p.p) + chev + "</td>" +
        '<td class="num">' + fmtN(p.n) + '</td><td class="num">' + fmtB(p.b) + "</td>" +
        "<td>" + fmtWin(p.o, p.w, thisYear) + "</td>" +
        '<td class="contents lastcol">' + mostly(p) + famtxt + "</td></tr>";
    });

    let lrows = "";
    for (const [key, sz, d] of r.largest.slice(0, 10)) {
      lrows += '<tr><td class="key firstcol">' + esc(key) + '</td><td class="num">' + fmtB(sz) + '</td><td class="num lastcol">' + fmtD(d, thisYear) + "</td></tr>";
    }
    const largestCard = lrows
      ? '<div class="card tablecard"><h2>Largest objects</h2>' +
        '<table><thead><tr><th class="firstcol">Key</th><th class="num">Size</th><th class="num lastcol">Modified</th></tr></thead>' +
        "<tbody>" + lrows + "</tbody></table></div>"
      : "";

    const hidden = bst.cwObjects - r.n;
    let about = a.note ? esc(a.note) : "";
    if (hidden > 1000 && hidden > r.n * 0.01) {
      about += (about ? " " : "") +
        "CloudWatch counts about " + fmtN(hidden) + " more objects than the listing shows, likely old versions kept by bucket versioning; a lifecycle rule expiring noncurrent versions would reclaim that storage.";
    }
    const aboutCard = about ? '<div class="card chart"><h2>About</h2><p class="about">' + about + "</p></div>" : "";

    const tiles =
      '<div class="tiles4">' +
      '<div class="card tile"><div class="label">Stored</div><div class="value">' + fmtB(r.b) + '</div><div class="sub">' + topShare + "</div></div>" +
      '<div class="card tile"><div class="label">Objects</div><div class="value">' + fmtN(r.n) + '</div><div class="sub">' + r.prefixes.length + " top-level folders</div></div>" +
      '<div class="card tile"><div class="label">Cost</div><div class="value">$' + fmtUsd(bst.estMonthly) + '<span style="font-size:15px;color:var(--text-2);font-weight:500;">/mo</span></div><div class="sub">storage, estimated</div></div>' +
      '<div class="card tile"><div class="label">Last write</div><div class="value">' + (fmtD(lastW, thisYear) || "–") + '</div><div class="sub">' + (esc(lastP) || "no objects") + "</div></div>" +
      "</div>";

    const ptable = prows
      ? '<div class="card tablecard"><h2>By folder</h2><p class="sub">Sorted by size. Activity is the first-to-last write window.</p>' +
        '<table><thead><tr><th class="firstcol">Folder</th><th class="num">Objects</th><th class="num">Size</th><th>Activity</th><th class="lastcol">Mostly</th></tr></thead>' +
        "<tbody>" + prows + "</tbody></table></div>"
      : '<div class="card chart"><p class="about">Empty bucket.</p></div>';

    pages.push(
      '<div id="page-' + slug + '" class="page">' +
      '<div class="crumb"><a href="#">All buckets</a> › ' + esc(r.bucket) + "</div>" +
      '<div class="pagehead"><a class="backbtn" href="#" aria-label="Back">←</a><h1>' + esc(r.bucket) + "</h1>" + (anyVerdict ? chip(a.verdict) : "") + "</div>" +
      '<div class="meta">' + esc(r.region || "") + (a.project ? " · " + esc(a.project) : "") + "</div>" +
      tiles + aboutCard + ptable + largestCard +
      '<div class="foot">Full object enumeration via live S3 listing · nothing modified.</div>' +
      "</div>"
    );

    // folder pages
    r.prefixes.forEach((p, i) => {
      if (!p.c || !p.c.length) return;
      const pid = "p-" + slugs.get(r.bucket) + "-" + i;
      let crows = "";
      for (const k of p.c) {
        crows +=
          '<tr><td class="bname firstcol">' + esc(k.p) + "</td>" +
          '<td class="num">' + fmtN(k.n) + '</td><td class="num">' + fmtB(k.b) + "</td>" +
          "<td>" + fmtWin(k.o, k.w, thisYear) + "</td>" +
          '<td class="contents lastcol">' + mostly(k) + "</td></tr>";
      }
      let fcard = "";
      if (p.f && p.f.length) {
        let frows = "";
        for (const [pat, cnt, bb] of p.f.slice(0, 8)) {
          frows += '<tr><td class="key firstcol">' + esc(pat) + '</td><td class="num">' + fmtN(cnt) + '</td><td class="num lastcol">' + fmtB(bb) + "</td></tr>";
        }
        fcard =
          '<div class="card tablecard"><h2>Common file patterns</h2>' +
          '<p class="sub"># stands in for any run of digits or hex, so one row is a whole family.</p>' +
          '<table><thead><tr><th class="firstcol">Pattern</th><th class="num">Files</th><th class="num lastcol">Size</th></tr></thead>' +
          "<tbody>" + frows + "</tbody></table></div>";
      }
      pages.push(
        '<div id="page-' + pid + '" class="page">' +
        '<div class="crumb"><a href="#">All buckets</a> › <a href="#' + slug + '">' + esc(r.bucket) + "</a> › " + esc(p.p) + "</div>" +
        '<div class="pagehead"><a class="backbtn" href="#' + slug + '" aria-label="Back">←</a><h1>' + esc(p.p) + "</h1></div>" +
        '<div class="meta">' + esc(r.bucket) + " · " + fmtN(p.n) + " objects · " + fmtB(p.b) + " · " + fmtWin(p.o, p.w, thisYear) + "</div>" +
        '<div class="card tablecard"><h2>Folders</h2><p class="sub">Sorted by size.</p>' +
        '<table><thead><tr><th class="firstcol">Folder</th><th class="num">Objects</th><th class="num">Size</th><th>Activity</th><th class="lastcol">Mostly</th></tr></thead>' +
        "<tbody>" + crows + "</tbody></table></div>" + fcard +
        '<div class="foot">Aggregated from the full object listing.</div>' +
        "</div>"
      );
    });
  }

  return (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>Bucket List</title>\n<style>\n" + CSS_VARS + "\n" + CSS + "\n</style>\n</head>\n<body>\n" +
    '<div class="wrap">\n' + pages.join("\n") + "\n</div>\n" + SCRIPT + "\n</body>\n</html>\n"
  );
}

module.exports = { render };

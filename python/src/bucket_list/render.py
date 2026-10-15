"""Renders the sweep into a single self-contained HTML file:
hash-routed pages (catalog -> bucket -> folder), search, chart, dark mode.
Mirrors lib/render.js; the CSS and client script are shared verbatim."""
import datetime
import math
import re

from ._assets import CSS, CSS_VARS, SCRIPT

MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
CHIP = {"keep": ("keep", "Keep"), "review": ("review", "Review"), "disposable": ("disp", "Disposable"), "empty": ("disp", "Empty")}

GB = 1024 ** 3


def _round(x):
    # JS Math.round: half rounds up, unlike Python's banker's rounding.
    return int(math.floor(x + 0.5))


def esc(s):
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;").replace("'", "&#39;")
    )


def fmt_b(b):
    if b <= 0:
        return "0"
    if b < 1024:
        return "%d B" % b
    if b < 1024 ** 2:
        return "%d KB" % _round(b / 1024)
    if b < GB:
        return "%.1f MB" % (b / 1024 ** 2)
    return "%.1f GB" % (b / GB) if b < 100 * GB else "%d GB" % _round(b / GB)


def fmt_n(n):
    return "{:,}".format(int(n))


def fmt_d(d, this_year):
    if not d or d == "9999":
        return ""
    y, m, dd = d[0:4], int(d[5:7]), int(d[8:10])
    base = "%s %d" % (MONTHS[m], dd)
    return base if y == this_year else base + ", " + y


def fmt_win(o, w, this_year):
    fo, fw = fmt_d(o, this_year), fmt_d(w, this_year)
    if not fo and not fw:
        return "–"
    return fo if fo == fw else fo + " – " + fw


def fmt_usd(u):
    if u >= 0.01:
        return "%.2f" % u
    return "&lt;0.01" if u > 0 else "0"


def mostly(node):
    bits = [esc(e) + " " + fmt_b(bb) for e, bb in (node.get("x") or [])[:2] if bb > 0]
    return " · ".join(bits) if bits else "–"


def chip(v):
    c = CHIP.get(v)
    return '<span class="chip ' + c[0] + '"><span class="dot"></span>' + c[1] + "</span>" if c else ""


_EMPTY_STATS = {"cwObjects": 0, "classes": {}, "estMonthly": 0.0}


def render(results, stats, notes=None, account=""):
    """results: serialized sweeps ({bucket,n,b,largest,prefixes,region});
    stats: {bucket: {cwObjects, classes, estMonthly}}; notes: {bucket: {verdict, note, project}}."""
    notes = notes or {}
    now = datetime.datetime.now()
    this_year = str(now.year)
    gen_date = "%s %d, %d" % (MONTHS[now.month], now.day, now.year)

    def st(b):
        return stats.get(b) or _EMPTY_STATS

    def note(b):
        a = notes.get(b)
        return a if isinstance(a, dict) else {}

    order = sorted(results, key=lambda r: (-st(r["bucket"])["estMonthly"], -r["b"]))

    slugs, used = {}, set()
    for r in order:
        s = re.sub(r"-+", "-", re.sub(r"[^a-z0-9-]", "-", r["bucket"].lower()))[:50]
        while s in used:
            s += "x"
        used.add(s)
        slugs[r["bucket"]] = s

    total_n = sum(r["n"] for r in order)
    total_b = sum(r["b"] for r in order)
    total_mo = sum(st(r["bucket"])["estMonthly"] for r in order)
    regions = []
    for r in order:
        if r.get("region") and r["region"] not in regions:
            regions.append(r["region"])
    cold_b = 0.0
    for r in order:
        c = st(r["bucket"])["classes"]
        cold_b += (c.get("GlacierInstantRetrievalStorage", 0) + c.get("GlacierStorage", 0) + c.get("DeepArchiveStorage", 0)) * GB

    def hidden_of(r):
        return st(r["bucket"])["cwObjects"] - r["n"]

    hidden_buckets = [r for r in order if hidden_of(r) > 1000 and hidden_of(r) > r["n"] * 0.01]
    any_verdict = any(note(r["bucket"]).get("verdict") for r in order)
    pages = []

    # -------------------------------------------------------------- main page
    rows = ""
    for r in order:
        a = note(r["bucket"])
        slug = "b-" + slugs[r["bucket"]]
        prefs = [esc(p["p"]) for p in r["prefixes"][:6]]
        contents = " · ".join(prefs) if prefs else "empty"
        if len(r["prefixes"]) > 6:
            contents += " and %d more" % (len(r["prefixes"]) - 6)
        noteh = '<span class="note">' + esc(a["note"]) + "</span>" if a.get("note") else ""
        rows += (
            '<tr class="rowlink" onclick="location.hash=\'' + slug + '\'">'
            '<td class="bname firstcol">' + esc(r["bucket"]) + '<span class="chev">›</span>'
            '<span class="proj">' + esc(a.get("project") or r.get("region") or "") + "</span></td>"
            + ("<td>" + chip(a.get("verdict")) + "</td>" if any_verdict else "")
            + '<td class="num">' + fmt_b(r["b"]) + '</td><td class="num">' + fmt_n(r["n"]) + '</td><td class="num">' + fmt_usd(st(r["bucket"])["estMonthly"]) + "</td>"
            '<td class="contents lastcol">' + contents + noteh + "</td></tr>"
        )

    chart_card = ""
    chart_items = [r for r in order if st(r["bucket"])["estMonthly"] >= 0.01][:12]
    if len(chart_items) >= 2:
        maxu = st(chart_items[0]["bucket"])["estMonthly"]
        other_u = total_mo - sum(st(r["bucket"])["estMonthly"] for r in chart_items)
        bars = ""
        for r in chart_items:
            u = st(r["bucket"])["estMonthly"]
            bars += (
                '<div class="barrow" data-label="' + esc(r["bucket"]) + '" data-val="$%.2f/mo"><div class="track">' % u
                + '<div class="bar" style="width:%.1f%%"></div></div><div class="val">$%.2f</div></div>' % (u / maxu * 100, u)
            )
        if other_u > 0.005:
            bars += (
                '<div class="barrow" data-label="%d more buckets" data-val="$%.2f/mo"><div class="track">' % (len(order) - len(chart_items), other_u)
                + '<div class="bar other" style="width:%.1f%%"></div></div><div class="val">$%.2f</div></div>' % (other_u / maxu * 100, other_u)
            )
        chart_card = (
            '<div class="card chart"><h2>Monthly cost by bucket</h2>'
            '<div style="position:relative;"><div class="axisline" style="left:0;"></div>' + bars + "</div></div>"
        )

    if total_mo > 0:
        hero = (
            '<div class="card hero"><div class="label">S3 storage cost</div>'
            '<div class="value">$%.2f<span style="font-size:22px;color:var(--text-2);font-weight:500;">/day</span></div>' % (total_mo / 30)
            + '<div class="sub">$%.2f per month, estimated at list prices</div></div>' % total_mo
        )
    else:
        hero = (
            '<div class="card hero"><div class="label">Stored</div>'
            '<div class="value">' + fmt_b(total_b) + "</div>"
            '<div class="sub">across %d buckets</div></div>' % len(order)
        )

    stored_tile = "%d%% in cold storage classes" % _round(cold_b / total_b * 100) if total_b > 0 and cold_b > 0 else "all storage classes"
    objects_sub = (
        "%d bucket%s also hide old versions" % (len(hidden_buckets), "s" if len(hidden_buckets) > 1 else "")
        if hidden_buckets else "current versions"
    )
    objects_val = "%.1fM" % (total_n / 1e6) if total_n >= 1e6 else fmt_n(total_n)
    region_sub = "across %d regions" % len(regions) if len(regions) > 1 else (regions[0] if regions else "")

    pages.append(
        '<div id="page-main" class="page">'
        "<h1>Bucket List</h1>"
        '<div class="meta">Lightweight search for S3</div>'
        '<div class="searchwrap"><input id="q" class="search" type="search" placeholder="Search buckets, folders, files" autocomplete="off"><div id="qr" class="qresults"></div></div>'
        '<div class="toprow">' + hero
        + '<div class="tiles">'
        '<div class="card tile"><div class="label">Stored</div><div class="value">' + fmt_b(total_b) + '</div><div class="sub">' + stored_tile + "</div></div>"
        '<div class="card tile"><div class="label">Objects</div><div class="value">' + objects_val + '</div><div class="sub">' + objects_sub + "</div></div>"
        '<div class="card tile"><div class="label">Buckets</div><div class="value">%d</div><div class="sub">' % len(order)
        + region_sub + "</div></div>"
        "</div></div>"
        + chart_card
        + '<div class="card tablecard"><h2>All %d buckets</h2>' % len(order)
        + '<p class="sub">Every row opens a drill-down. Sorted by cost.</p>'
        '<table><thead><tr><th class="firstcol">Bucket</th>' + ("<th>Verdict</th>" if any_verdict else "")
        + '<th class="num">Size</th><th class="num">Objects</th><th class="num">$/mo</th><th class="lastcol">Contents</th></tr></thead>'
        "<tbody>" + rows + "</tbody></table></div>"
        '<div class="foot">Full object enumeration via the AWS CLI · account ' + esc(account) + " · " + gen_date
        + " · storage only at us-east-1 list prices, an estimate; request and transfer charges excluded.</div>"
        "</div>"
    )

    # ------------------------------------------------- bucket + folder pages
    for r in order:
        a = note(r["bucket"])
        bslug = slugs[r["bucket"]]
        slug = "b-" + bslug
        bst = st(r["bucket"])
        last_w, last_p = "", ""
        for p in r["prefixes"]:
            if p["w"] > last_w:
                last_w, last_p = p["w"], p["p"]
        top_share = (
            "%d%% under %s" % (_round(r["prefixes"][0]["b"] / r["b"] * 100), esc(r["prefixes"][0]["p"]))
            if r["b"] > 0 and r["prefixes"] else "empty"
        )

        prows = ""
        for i, p in enumerate(r["prefixes"]):
            has_kids = bool(p.get("c"))
            pid = "p-%s-%d" % (bslug, i)
            click = ' class="rowlink" onclick="location.hash=\'' + pid + '\'"' if has_kids else ""
            chev = '<span class="chev">›</span>' if has_kids else ""
            fams = p.get("f") or []
            famtxt = " — " + esc(fams[0][0]) + " ×" + fmt_n(fams[0][1]) if fams and fams[0][1] > 2 else ""
            prows += (
                "<tr" + click + '><td class="bname firstcol">' + esc(p["p"]) + chev + "</td>"
                '<td class="num">' + fmt_n(p["n"]) + '</td><td class="num">' + fmt_b(p["b"]) + "</td>"
                "<td>" + fmt_win(p["o"], p["w"], this_year) + "</td>"
                '<td class="contents lastcol">' + mostly(p) + famtxt + "</td></tr>"
            )

        lrows = ""
        for key, sz, d in r["largest"][:10]:
            lrows += '<tr><td class="key firstcol">' + esc(key) + '</td><td class="num">' + fmt_b(sz) + '</td><td class="num lastcol">' + fmt_d(d, this_year) + "</td></tr>"
        largest_card = (
            '<div class="card tablecard"><h2>Largest objects</h2>'
            '<table><thead><tr><th class="firstcol">Key</th><th class="num">Size</th><th class="num lastcol">Modified</th></tr></thead>'
            "<tbody>" + lrows + "</tbody></table></div>"
            if lrows else ""
        )

        hidden = bst["cwObjects"] - r["n"]
        about = esc(a["note"]) if a.get("note") else ""
        if hidden > 1000 and hidden > r["n"] * 0.01:
            about += (" " if about else "") + (
                "CloudWatch counts about " + fmt_n(hidden) + " more objects than the listing shows, likely old versions kept by bucket versioning; "
                "a lifecycle rule expiring noncurrent versions would reclaim that storage."
            )
        about_card = '<div class="card chart"><h2>About</h2><p class="about">' + about + "</p></div>" if about else ""

        tiles = (
            '<div class="tiles4">'
            '<div class="card tile"><div class="label">Stored</div><div class="value">' + fmt_b(r["b"]) + '</div><div class="sub">' + top_share + "</div></div>"
            '<div class="card tile"><div class="label">Objects</div><div class="value">' + fmt_n(r["n"]) + '</div><div class="sub">%d top-level folders</div></div>' % len(r["prefixes"])
            + '<div class="card tile"><div class="label">Cost</div><div class="value">$' + fmt_usd(bst["estMonthly"]) + '<span style="font-size:15px;color:var(--text-2);font-weight:500;">/mo</span></div><div class="sub">storage, estimated</div></div>'
            '<div class="card tile"><div class="label">Last write</div><div class="value">' + (fmt_d(last_w, this_year) or "–") + '</div><div class="sub">' + (esc(last_p) or "no objects") + "</div></div>"
            "</div>"
        )

        ptable = (
            '<div class="card tablecard"><h2>By folder</h2><p class="sub">Sorted by size. Activity is the first-to-last write window.</p>'
            '<table><thead><tr><th class="firstcol">Folder</th><th class="num">Objects</th><th class="num">Size</th><th>Activity</th><th class="lastcol">Mostly</th></tr></thead>'
            "<tbody>" + prows + "</tbody></table></div>"
            if prows else '<div class="card chart"><p class="about">Empty bucket.</p></div>'
        )

        pages.append(
            '<div id="page-' + slug + '" class="page">'
            '<div class="crumb"><a href="#">All buckets</a> › ' + esc(r["bucket"]) + "</div>"
            '<div class="pagehead"><a class="backbtn" href="#" aria-label="Back">←</a><h1>' + esc(r["bucket"]) + "</h1>" + (chip(a.get("verdict")) if any_verdict else "") + "</div>"
            '<div class="meta">' + esc(r.get("region") or "") + (" · " + esc(a["project"]) if a.get("project") else "") + "</div>"
            + tiles + about_card + ptable + largest_card
            + '<div class="foot">Full object enumeration via live S3 listing · nothing modified.</div>'
            "</div>"
        )

        # folder pages
        for i, p in enumerate(r["prefixes"]):
            if not p.get("c"):
                continue
            pid = "p-%s-%d" % (bslug, i)
            crows = ""
            for k in p["c"]:
                crows += (
                    '<tr><td class="bname firstcol">' + esc(k["p"]) + "</td>"
                    '<td class="num">' + fmt_n(k["n"]) + '</td><td class="num">' + fmt_b(k["b"]) + "</td>"
                    "<td>" + fmt_win(k["o"], k["w"], this_year) + "</td>"
                    '<td class="contents lastcol">' + mostly(k) + "</td></tr>"
                )
            fcard = ""
            if p.get("f"):
                frows = ""
                for pat, cnt, bb in p["f"][:8]:
                    frows += '<tr><td class="key firstcol">' + esc(pat) + '</td><td class="num">' + fmt_n(cnt) + '</td><td class="num lastcol">' + fmt_b(bb) + "</td></tr>"
                fcard = (
                    '<div class="card tablecard"><h2>Common file patterns</h2>'
                    '<p class="sub"># stands in for any run of digits or hex, so one row is a whole family.</p>'
                    '<table><thead><tr><th class="firstcol">Pattern</th><th class="num">Files</th><th class="num lastcol">Size</th></tr></thead>'
                    "<tbody>" + frows + "</tbody></table></div>"
                )
            pages.append(
                '<div id="page-' + pid + '" class="page">'
                '<div class="crumb"><a href="#">All buckets</a> › <a href="#' + slug + '">' + esc(r["bucket"]) + "</a> › " + esc(p["p"]) + "</div>"
                '<div class="pagehead"><a class="backbtn" href="#' + slug + '" aria-label="Back">←</a><h1>' + esc(p["p"]) + "</h1></div>"
                '<div class="meta">' + esc(r["bucket"]) + " · " + fmt_n(p["n"]) + " objects · " + fmt_b(p["b"]) + " · " + fmt_win(p["o"], p["w"], this_year) + "</div>"
                '<div class="card tablecard"><h2>Folders</h2><p class="sub">Sorted by size.</p>'
                '<table><thead><tr><th class="firstcol">Folder</th><th class="num">Objects</th><th class="num">Size</th><th>Activity</th><th class="lastcol">Mostly</th></tr></thead>'
                "<tbody>" + crows + "</tbody></table></div>" + fcard
                + '<div class="foot">Aggregated from the full object listing.</div>'
                "</div>"
            )

    return (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>Bucket List</title>\n<style>\n" + CSS_VARS + "\n" + CSS + "\n</style>\n</head>\n<body>\n"
        '<div class="wrap">\n' + "\n".join(pages) + "\n</div>\n" + SCRIPT + "\n</body>\n</html>\n"
    )

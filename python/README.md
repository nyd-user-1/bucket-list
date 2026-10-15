# Bucket List

Lightweight search for S3.

One command sweeps every bucket in your AWS account and writes a single
self-contained HTML file: drill down from account to bucket to folder, with
object counts, storage-class cost estimates, activity windows, largest files,
common file-name patterns, and instant search across everything. The file works
offline, in light and dark mode, and weighs a few hundred kilobytes even for
accounts with millions of objects.

```
pipx run --spec nysgpt-bucket-list bucket-list --open
```

or install it once:

```
pipx install nysgpt-bucket-list     # or: pip install nysgpt-bucket-list
bucket-list --open
```

The package is `nysgpt-bucket-list`; the command it installs is `bucket-list`.

## Why

AWS's own answers to "what's in my S3?" are Storage Lens, which stops at
bucket-level numbers, and S3 Inventory, which takes 24 hours and hands you
Parquet files. Neither gives you an instant, browsable, shareable picture.
Bucket List does, in minutes, for about a nickel per 10 million objects.

## Requirements

- The AWS CLI (v2) installed and configured with credentials that can list
  buckets, list objects, and read CloudWatch metrics
- Python 3.9+ (standard library only, no dependencies)

That's the whole stack. No SDK, no AI, no cloud service, no telemetry. If
`aws s3 ls` works in your terminal, Bucket List works, whatever terminal,
agent, or editor you run it from.

## Usage

```
bucket-list [options]

  --output <file>       output path            (default: bucket-list.html)
  --buckets <a,b,c>     only these buckets     (default: every bucket)
  --notes <file>        annotations JSON       (default: ./bucket-list.notes.json if present)
  --concurrency <n>     parallel AWS calls     (default: 12)
  --yes                 skip the cost estimate confirmation
  --open                open the file when done
```

Before sweeping, it estimates the job from CloudWatch metrics and asks:

```
32 buckets, ~8,500,000 objects, ~2.1 TB (CloudWatch estimate).
Sweep will make ~10,300 LIST requests: ~$0.05, roughly 6 min.
Proceed? [y/N]
```

## What it does, exactly

- Discovers every bucket with `list-buckets` and resolves each bucket's region.
- Walks each bucket by folder, recursively splitting anything too large into
  parallel streams, so a bucket with one five-million-object folder sweeps in
  minutes instead of an hour.
- Reads names, sizes, and dates only. It never downloads an object's contents
  and never modifies anything. Glacier-stored objects are listed for free like
  everything else.
- Prices each bucket from CloudWatch per-storage-class metrics against the
  us-east-1 list-price table, clearly labeled as an estimate.
- Flags buckets where CloudWatch counts far more objects than the listing
  shows, which usually means old versions kept by bucket versioning and
  reclaimable with a lifecycle rule.

## Annotations

The generator knows nothing about your projects. If you want it to, drop a
`bucket-list.notes.json` next to where you run it:

```json
{
  "my-app-assets": { "verdict": "keep", "note": "serves production", "project": "my-app" },
  "old-experiments": { "verdict": "disposable", "note": "rebuildable from source data" }
}
```

Verdicts render as chips (`keep`, `review`, `disposable`, `empty`), notes
appear on the bucket's row and page, and the columns only appear if you use
them.

## Other ways to run it

The same engine ships three ways, all producing the same HTML file:

- **npm**: `npx @nysgpt/bucket-list --open` (Node.js 18+)
- **PyPI**: this package
- **Desktop app**: a native window that walks through the estimate, sweeps
  with live progress, and renders the dashboard in place. Runs from the
  [GitHub repo](https://github.com/nyd-user-1/bucket-list).

## License

MIT

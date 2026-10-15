# Landing page

Static, two files: `index.html` (HQ's landing-page design) and `demo.html`, a real
Bucket List report rendered by `lib/render.js` over a fictional account.

Live at https://main.d33wlkvxg20gld.amplifyapp.com (Amplify app `bucket-list-site`,
us-east-1, branch `main`, no connected repo).

Redeploy by manual upload, the same way as `hq-site`:

```
node site/make-demo.js                       # only if lib/render.js changed
(cd site && zip -X /tmp/site.zip index.html demo.html)
aws amplify create-deployment --app-id d33wlkvxg20gld --branch-name main   # returns jobId + zipUploadUrl
curl -X PUT --upload-file /tmp/site.zip -H "Content-Type: application/zip" "<zipUploadUrl>"
aws amplify start-deployment --app-id d33wlkvxg20gld --branch-name main --job-id <jobId>
```

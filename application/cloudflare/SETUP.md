# Independent Cloudflare setup

This configuration is prepared but not deployed or verified in an owner-controlled Cloudflare account.

1. Create separate staging and production D1 databases and private R2 buckets in the church's account. Never reuse production storage bindings in staging.
2. Fill in wrangler.jsonc with the D1 ID, bucket name and your custom domain route. The configuration disables workers.dev; attach a staging custom domain before deploying.
3. Import the verified full-database.sql into an EMPTY database. Do not run original migrations on top of that dump. Keep the SQL migration files for schema history and future changes.
4. Upload each backup media object under its original key. Preserve HTTP and custom metadata from objects.json. Sidecar JSON files are metadata, not extra bucket objects. Keep the bucket private: the Worker controls public/private media access.
5. In Cloudflare Zero Trust, create a self-hosted Access application covering ONLY your staging hostname's /signin-with-chatgpt path, including its query strings. Do not protect the public reader or bypass this path. Allow only the intended editor emails, using an individual identity provider or email one-time PIN. Set the session duration deliberately.
6. Set ACCESS_TEAM_DOMAIN to the exact https://YOUR-TEAM.cloudflareaccess.com issuer and ACCESS_AUD to that application's audience tag. The Worker verifies signed tokens; it does not trust email headers. Users also have to be in the editor allowlist at the start of dist/server/index.js. Preserve the original owner's email in imported project records. The adapter never treats an arbitrary new provider's account ID as the old Sites owner ID.
7. Deploy the standalone entrypoint cloudflare/worker.mjs, not dist/server/index.js directly. Without Access configuration, the public reader can operate but editor access fails closed.
8. Verify staging with real accounts: anonymous completed hymns work; private drafts, project lists, uploads and writes are blocked anonymously; each approved editor can sign in at /signin-with-chatgpt and view My Projects; unapproved users are denied; logout removes access; a forged Sites identity header never grants access. Check audio seeking and saved edits after reload. Do not make arbitrary changes to production hymn data for this test.
9. Repeat using separate production resources and Access application/AUD. Confirm backups and rollback before DNS cutover. Configure deployment credentials/pipeline only after staging passes.

The original Sites product remains separate and has not been migrated by these files. The existing UI route names are retained for compatibility; independent hosting uses Cloudflare Access instead of ChatGPT sessions. Configure your Access application so its cookie is available to the same-origin API requests. Confirm this with browser QA before production release.

Official references:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- https://developers.cloudflare.com/r2/objects/upload-objects/

## Recording restore helper

Run `python3 ../migration/upload-r2.py` to validate local backup objects without network access. For a real upload, install boto3, set `R2_ENDPOINT_URL`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` privately in your environment, then run `python3 ../migration/upload-r2.py --upload`. Use bucket-scoped credentials for a NEW EMPTY staging bucket. The helper refuses a nonempty destination, preserves metadata and downloads every uploaded object to compare its hash. It does not modify the original Site.

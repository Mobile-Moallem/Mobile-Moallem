# Mobile Moallem team handoff

This package is intended for a private GitHub organization repository and a shared Cloudflare app with individual team sign-in. Read TEAM-HANDOFF-STATUS.md for the exact verified state.

## Start here

- Developers: work in application/ within this private repository, read CONTRIBUTING.md and cloudflare/SETUP.md. Node.js 24 or newer is required.
- Site data: live-backup/ contains the full captured database, SQL dump, raw schema/table exports and all captured R2 files with metadata and hashes. It is intentionally included in this private repository.
- Local development: from application/, run npm test, then npm run restore:backup and npm run dev. The restore refuses to overwrite existing local data. Copy .env.example to .env.local and choose a private LOCAL_EDITOR_PASSWORD of at least 16 characters to try local editing. This is a loopback preview only.
- Independent hosting: provision separate staging and production resources, fill in wrangler.jsonc and set up Cloudflare Access per cloudflare/SETUP.md. Deploy cloudflare/worker.mjs. The original Worker alone trusts Sites identity headers and must not be deployed directly as the standalone entrypoint.
- Media restore: migration/upload-r2.py validates backup files locally by default; --upload requires separately supplied R2 credentials and a new empty bucket. It preserves object metadata and verifies remote bytes. The remote upload path has not been run against your account.

## Scope

All captured application and migration-history tables, database text, timing arrays, repeat definitions, drafts and stored media are included. Existing null/unverified alignment slots remain unchanged. This export does not validate musical timing. The database was read twice for matching values; this is not a transactional platform snapshot. Later live edits are not automatically copied into the ZIP.

External recordings remain linked to their original hosts. external-recording-urls.json lists the references and source locations. Their audio bytes are not bundled. migration/download-external-recordings.py optionally downloads those URLs with a separate manifest; it does not modify the app's recording URLs.

## Hosting and authentication

The original site runs through ChatGPT Sites, backed by Cloudflare D1 (DB), R2 (BUCKET) and static assets (ASSETS). The Sites gateway validates login and injects oai-authenticated-user-id/email. It owns /signin-with-chatgpt, /signout-with-chatgpt and /callback. Gateway code, active sessions, provider account credentials and internal deployment configuration are not exportable through the available tools.

Original source is preserved under application/, including .openai/hosting.json for reference. The new wrangler.jsonc is a standalone deployment configuration, not the internal Sites configuration. The added Cloudflare adapter validates Access JWT signatures and identity before supplying the app's editor email. It preserves the existing email allowlist and does not map arbitrary provider IDs to the original owner account ID. Cloudflare Access account configuration and a real browser sign-in test are still required. No independent production deployment or domain cutover has occurred.

The source-defined editor email allowlist and project-owner email must be preserved or deliberately migrated. People editing the shared website use the same database. Give each hymn one active editor at a time until simultaneous-save conflict protection has been implemented and verified.

## Credentials and sharing

No runtime secret values or private API credentials are included. environment-variable-names.json records only names. Keep this repository PRIVATE because it contains drafts, database records and recordings. At the owner's explicit request, the complete application and data backup are tracked together. Team members should use individual GitHub and editor accounts. Historical chat conversations and unrelated earlier local research are outside this site export.

# Mobile Moallem team handoff status

Fresh backup completed: 2026-10-15T23:32:28.704685+00:00. Product source: version 87, commit b4102462ebbf10dbcfa9bbb7c3610a4aff657baa. Cleanup production version 90 has the same deployment archive hash as version 87: sha256:809fdacf2a4691b912d4cda8cbb19163f41c17d1f47855895de2f64be27a744e.

## Included and verified

- All current client/Worker source, styles, fonts, catalog assets, schema and seven D1 migrations. Original product files are preserved; standalone tools are separate, with .gitignore extended.
- All 14 captured tables, 315 rows and 98 hymn projects. Raw JSON, schema, SQLite and full SQL dump contain untruncated values.
- All 29 captured R2 objects: 27 recordings and two Hazzat images, totaling 197,741,966 bytes. Original keys, sizes, HTTP/custom metadata and SHA-256 hashes are included.
- Every project's four timing arrays, English/Coptic text and notation match through the restored app. Local editor sign-in works; 74 completed projects are public and 24 drafts stay private. All uploaded recordings serve expected bytes. Active recordings support ranges; retained references preserve the original full-file response.
- Two complete database reads matched; bucket inventory/schema stayed unchanged. SQLite integrity and foreign keys pass. Every SQL-restored value matches the database; raw JSON values also match.
- 73 automated product/local/authentication checks pass. The R2 restore helper validates all 29 backup objects locally.
- Independent Cloudflare Access JWT adapter, Wrangler template, local preview/restore, GitHub checks and contribution/release instructions.

## Production cleanup

The user explicitly approved the temporary secret-protected read-only export. It ran as version 89 and was removed as version 90. The export secret was removed (environment revision 8); the old secret gets 404. Public reader: 200; anonymous canEdit: false; private projects: 403; sign-in redirects to auth.openai.com. No export route or secret values are included. The export did not change hymn data.

## Remaining setup and boundaries

375 external Tasbeha recordings remain linked; their audio bytes are not bundled. All source references and a separate URL inventory are preserved, with an optional downloader. All uploaded R2 recordings ARE included. This is a capture at the time above, not ongoing synchronization or a transactional snapshot. Existing unknown/unverified timing slots remain unchanged.

GitHub organization/repository, branch protection, Cloudflare resources, staging domain and Access application still need configuration in your accounts. No invitations, independent production deployment or DNS cutover occurred. Sign-in code is tested with signed tokens; real-provider/browser testing is still required on staging. R2 uploading has not been run against your account.

Use reviewed pull requests for code and one shared hosted database for hymn editing. Assign each hymn one active editor at a time until simultaneous-save conflict protection is implemented and verified. See application/CONTRIBUTING.md and application/cloudflare/SETUP.md.

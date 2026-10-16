# Working together on Mobile Moallem

Use the complete package as one PRIVATE repository in the church's GitHub organization; application/ contains the code. Keep at least two trusted organization owners, individual accounts and two-factor authentication. Invite developers to the repository; invite content editors separately through Cloudflare Access and the app's editor email allowlist.

For code changes, branch from main, implement one focused change, run npm test, open a pull request and have another team member review it. Require passing checks and approval before merging. Configure branch protection in GitHub; a workflow file alone does not enforce review. Do not force-push main.

Use separate Cloudflare Workers, D1 databases, R2 buckets and Access applications for staging and production. Staging must never write to production storage. Test code changes and sign-in on staging before release. CI runs tests only until a deployment pipeline has been configured in the church's account; merging main does not yet deploy anything.

Content editors work against the shared hosted app, not separate ZIP copies of the live database. Local backups are for development and recovery. Do not import a developer's database over production to publish code. Simultaneous editing of the same hymn is not proven conflict-safe: assign a hymn to one editor at a time until the save flow has explicit conflict protection.

The owner explicitly requested database dumps, private drafts and media backups in this PRIVATE repository. Keep .env files, API tokens and credentials outside Git. Give repository access only to authorized maintainers. Production secrets belong in Cloudflare, and deployment credentials belong in narrowly scoped GitHub environment secrets if automated deployment is configured. Nobody should need another person's login.

Before changing schema, take a fresh backup. Keep original migrations immutable and add new migrations for future changes. A full database dump already includes its schema: import it only into an empty database, not a database with migrations already applied.

Maintain a known rollback release and private database/media backup. Release code separately from data changes. Record the source commit and deployment identity for each production release.

# Mobile Moallem

Read ../README.md and ../TEAM-HANDOFF-STATUS.md. This is the current product source plus standalone Cloudflare and local tools. Node.js 24+ is required; local tests and preview need no npm dependencies.

```
npm test
npm run restore:backup
npm run dev
```

For local editor access, copy .env.example to .env.local, choose a LOCAL_EDITOR_PASSWORD of at least 16 characters, restart and open /signin-with-chatgpt. Shared online hosting requires cloudflare/SETUP.md. The complete ../live-backup/ directory is needed for restore and is tracked in this private repository at the owner's request.

Read CONTRIBUTING.md for teamwork. Use cloudflare/worker.mjs for independent hosting; the original Worker trusts Sites headers and must not be exposed directly on a public origin. Account provisioning and real team sign-in still require configuration and staging verification.

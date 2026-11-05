# mobilemoallem.com cutover and rollback

Cutover on 2026-11-05: mobilemoallem.com moved from ChatGPT Sites to the Cloudflare Worker `mobile-moallem`
(production env, D1 `mobile-moallem-production`, R2 `mobile-moallem-media-production`, Access app `production`).

## DNS before cutover (zone mobilemoallem.com)

| Type | Name | Content | Proxied | TTL |
|------|------|---------|---------|-----|
| A | mobilemoallem.com | 172.66.3.26 | no (DNS only) | Auto |
| A | mobilemoallem.com | 162.159.143.30 | no (DNS only) | Auto |

These pointed at ChatGPT Sites. Left untouched: TXT `_cf-custom-hostname`, TXT google-site-verification,
TXT `_openai-site-verification` (ChatGPT Sites still needs these if we roll back). No `www` record existed.

## Roll back to ChatGPT Sites

1. Workers & Pages → `mobile-moallem` → Domains → remove the `mobilemoallem.com` custom domain.
2. DNS → add back both A records above (DNS only, TTL Auto).
3. Remove `{ "pattern": "mobilemoallem.com", "custom_domain": true }` from `env.production.routes` in
   `application/wrangler.jsonc` on the `production` branch, so the next release doesn't re-add it.

Edits made on the new site after cutover live only in the new database; export them first if rolling back for good.

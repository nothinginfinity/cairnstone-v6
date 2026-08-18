# Deploy

Create Cloudflare resources:

```bash
npx wrangler d1 create cairnstone-v5
npx wrangler r2 bucket create cairnstone-v5-raw
```

Copy the D1 database id into `wrangler.toml`, then run:

```bash
npm install
npm run db:migrate:remote
npm run deploy
```

Local dev:

```bash
npm install
npm run db:migrate:local
npm run dev
```

Smoke test:

```bash
curl http://127.0.0.1:8787/health
```

# CairnStone v5

FSL-CCR Stone v5: a reversible, searchable, progressive, verifiable compression protocol built for Cloudflare Workers.

This repo is a clean v5 extraction inspired by the useful lessons from Headroom and Golden Library:

- Headroom-style CCR: compress, cache, retrieve on demand.
- Golden Library-style stones: LOD layers, `$ref` pointers, selective decompression, search-before-expand, and verifiable chains.
- FSL-native storage: D1 indexes, R2 originals, deterministic chunk refs, and compression receipts.

## Core idea

```text
raw repo / document / tool output
  -> classify
  -> compress into refs
  -> store original in R2
  -> index refs in D1
  -> wrap as CairnStone
  -> search / preview / expand only what is needed
```

## Worker API

```text
GET  /health
POST /v1/stones
GET  /v1/stones/:hash
GET  /v1/stones/:hash/lod/:level
POST /v1/search
POST /v1/expand
```

## Cloudflare resources

This starter expects:

- `CAIRNSTONE_DB` — D1 database for stones, refs, and receipts.
- `CAIRNSTONE_RAW` — R2 bucket for raw originals and compressed bodies.

Create them later with Wrangler, then update `wrangler.toml`.

## Local dev

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Current status

This is the first scaffold. It includes the protocol types, Worker routes, schema, D1 migration, and docs. The compression engine currently creates deterministic searchable stones and stores originals. Next step is to add AST-aware code compression, SmartCrusher-style JSON compression, and provider/cache-aware prompts.

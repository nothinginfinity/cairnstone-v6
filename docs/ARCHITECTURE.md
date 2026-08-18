# Architecture

CairnStone v5 merges three compression lines:

1. Headroom-style CCR — compress aggressively, keep originals, retrieve on demand.
2. Golden Library-style selective decompression — search compressed indexes, preview, expand only matching refs.
3. FSL/Cairn stone walks — deterministic refs, chainable context, verifiable receipts.

## Layers

```text
LOD5  50-token summary
LOD4  200-token key points
LOD3  outline / subsystem map
LOD2  compressed ref index
LOD1  raw original pointer in R2
```

## Storage

```text
D1:
  stones
  refs
  receipts

R2:
  raw/{sha256}.txt
  future: compressed/{stone_hash}.v5
```

## Query path

```text
POST /v1/search
  -> D1 keyword/ref search
  -> return previews and refs

POST /v1/expand
  -> locate ref in D1
  -> fetch raw original from R2
  -> return exact line window
```

## Why this matters

The system does not force a model to choose between tiny summaries and full decompression. It allows progressive context loading:

```text
summary -> outline -> refs -> exact raw lines
```

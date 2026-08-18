# CairnStone Protocol v5

## Stone

A CairnStone is a compressed, searchable, progressively loadable, verifiable context object.

```json
{
  "border": {
    "hash": "sha256...",
    "author": "jared@wallet_or_handle",
    "created": "2026-06-21T00:00:00Z",
    "title": "Example",
    "repo": "owner/repo",
    "commit": "abc123",
    "parent": null,
    "chain": null,
    "signature": null
  },
  "layers": {
    "lod5": "tiny summary",
    "lod4": "key points",
    "lod3": "outline",
    "lod2": {
      "compressed_index": [],
      "receipt": {}
    },
    "lod1": {
      "raw_key": "raw/hash.txt",
      "raw_bytes": 123
    }
  }
}
```

## Ref

A ref points to an exact retrievable window.

```text
$fsl#abc123
```

Each ref stores:

```text
stone_hash
path
line_start
line_end
keywords
preview
raw_key
```

## Expansion

Expansion is intentionally explicit. A model should first search, then preview, then expand.

```text
search("auth bug")
preview($fsl#abc)
expand($fsl#abc, context=10)
```

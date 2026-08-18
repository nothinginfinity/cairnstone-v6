# Smoke Test

1. Open `/health`.
2. Send `examples/create-stone.json` to `/v1/stones`.
3. Send `examples/search.json` to `/v1/search`.
4. Replace the placeholder ref in `examples/expand.json` with a real returned ref id and send it to `/v1/expand`.

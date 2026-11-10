# streamhold

[![Scan to join the developer community](https://streamhold.heartstack.space/svg/tsfullstack/group/gs.svg?from=streamhold)](https://tsfullstack.heartstack.space/group/gs?from=streamhold)

**English | [简体中文](README.zh-CN.md)**

A placeholder keep-alive reverse proxy: image requests to **cold-start upstreams** never time out in front of **impatient intermediaries**.

## The problem

The upstream being proxied is an on-demand service with cold starts (e.g. services hosted by [DynaPM](https://github.com/2234839/DynaPM)): the first request can take 2\~4 seconds before the first byte arrives. Proxies along the way (GitHub camo with ~3\~12s patience, various CDN/gateway idle timeouts) give up during the "connected but zero bytes" window (499/504), resulting in broken images in README files.

Lots of people hit this: in GitHub community discussions [#143996](https://github.com/orgs/community/discussions/143996) and [#183464](https://github.com/orgs/community/discussions/183464), the broken images come from other people's stat-card servers going down. My case is different — my own backend is cold-starting — but the outcome is the same: the upstream is too slow to produce bytes, and camo won't wait. streamhold makes sure camo always gets bytes: it holds the response stream open, no matter how long the upstream takes to wake up.

## How it works

Pure byte relay — no content parsing:

1. Request arrives → immediately fire the real upstream request, wait in a **100ms first-byte probe window**
2. Upstream responds within the window → **pure pass-through**, zero extra bytes (hot path)
3. Window expires → immediately commit a `200 + chunked` stream: write an unterminated XML comment `<!--`, then feed one space per second to keep the link alive (renderers ignore comments; the proxy's idle timeout is fed with bytes)
4. Upstream ready → write `-->` to close the comment, stream the full response body (cold path)
5. Upstream fails/times out → close the comment and return a tiny transparent SVG placeholder, so the stream always ends cleanly

The padding bytes are just an XML comment, perfectly legal inside `image/svg+xml`; downstream caches (camo/Fastly) also receive a complete, valid response and won't pin a half-finished object.

## Running

```bash
cp .env.example .env   # edit as needed (.env is gitignored)
pnpm build             # scriptc → native executable `streamhold`
./streamhold
```

## Routing

Request path format: `/<format>/<rule>/<path>`, for example:

```
/svg/tsfullstack/group/gs.svg
│   │           └── actual upstream path, forwarded as-is (query string appended)
│   └── rule name, resolved via the ROUTES env var to a target host (sent as the Host header upstream)
└── format declaration: content type of the streamed response
    (svg→image/svg+xml, xml→text/xml); decides the content-type committed
    by the cold-path padding mode
```

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `UPSTREAM` | `http://127.0.0.1:5300` | Upstream base URL (gateway or concrete service) |
| `ROUTES` | — | Routing table: `rule=TargetHost,rule2=Host2`, e.g. `tsfullstack=tsfullstack.heartstack.space` |
| `PORT` | `5310` | Listen port |
| `PROBE_MS` | `100` | Hot-path probe window (ms) |
| `PAD_INTERVAL_MS` | `1000` | Padding heartbeat interval; must be shorter than the shortest idle timeout on the link |
| `MAX_WAIT_MS` | `30000` | Total upstream wait limit; on timeout a placeholder image is returned |

`GET /healthz` returns `ok` for gateway health checks.

## Working with DynaPM

This service starts in milliseconds, so it can be **cold-hosted by DynaPM directly** (no keepWarm needed): the gateway spins it up on request and forwards. It probes the upstream first, feeding the link with comment padding until the upstream is ready — so slow cold starts of the business service behind it don't matter. Point your frontend (nginx location / image URLs) at this service's port.

## Deployment

```bash
# One command: compile to a native executable + push to the server
bun run deploy

# Equivalent step-by-step:
# scriptc build --optimization speed --strip streamhold.ts -o streamhold
# scp streamhold root@<server>:/root/app/streamhold/
```

On the server it is hosted by DynaPM: set the start command (`./streamhold`), env
vars
(.env is not auto-loaded; inject via DynaPM's env) and the health check
(`/healthz`). First deploy or updates only need the single command above. The
executable is self-contained — no runtime needs to be installed on the server.

> History: this used to run on LLRT (bytecode `.lrt`). Benchmarks showed the
> native build is ~3.4× faster throughput-wise, uses half the memory, and LLRT
> segfaulted under 50-concurrency load — see `doc/bench-scriptc-vs-llrt.md`.

# Codex LAN Remote

The Codex app-server owns thread and turn truth. The gateway owns authentication, runtime routing,
browser control leases and event sequencing. Browser state is a rebuildable projection.

Every workspace is resolved from authenticated user and opaque workspace id. Public requests never
accept host paths or arbitrary app-server methods. A single browser lease may mutate one workspace
at a time; observers remain read-only until an explicit takeover.

In `shared-host` mode the Codex managed daemon started with `daemon bootstrap --remote-control`
remains the only runtime owner. The gateway connects its control socket using the Codex remote
WebSocket-over-Unix transport at `/rpc`, resumes a thread before projecting it, and never stops the
owner when a browser disconnects. The raw `app-server proxy` command and a plain `app-server
--listen` endpoint are not JSONL adapters. Only the configured owner email may use this mode; one
gateway instance must not cross Linux user boundaries.

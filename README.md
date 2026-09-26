# @pipeworx/uk-trade-tariff

The UK Integrated Online Tariff from HMRC's trade-tariff service — commodity
codes, third-country and preferential duty rates by origin, VAT and excise,
import/export conditions, and live tariff-rate quota balances.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1684+ live data sources.

## Tools

- `uktariff_search(query, limit?, declarable_only?)` — find a commodity code
  from a plain-English product description, or resolve a numeric code.
- `uktariff_commodity(code, origin?, max_measures?)` — full duty detail for one
  10-digit code, with measures resolved against the JSON:API `included` graph.
- `uktariff_heading(heading, limit?)` — the codes under one 4-digit heading.
- `uktariff_quota(order_number?, goods_nomenclature_item_id?, geographical_area_id?, year?, critical?, limit?)`
  — tariff-rate quotas with remaining balance and status.

## Auth

Keyless.

## Data sources

- <https://www.trade-tariff.service.gov.uk/api/v2/search?q=> — classification search.
- <https://www.trade-tariff.service.gov.uk/api/v2/commodities/{code}> — duties and measures.
- <https://www.trade-tariff.service.gov.uk/api/v2/headings/{id}> — heading contents.
- <https://www.trade-tariff.service.gov.uk/api/v2/quotas/search> — TRQ balances.

Things worth knowing:

- **The host is `www.`, not `api.`.** `api.trade-tariff.service.gov.uk` 301s
  every `/api/v2` path to the documentation site with `content-length: 0`, so a
  client that follows redirects gets a 200 and an empty body — a call that looks
  successful and returns nothing.
- **Fuzzy search ANDs every term.** `q=roasted coffee beans` matches nothing
  because "beans" is not in the nomenclature, while `q=roasted coffee` returns
  40 commodities. Both are 200s with three empty arrays, which reads as "the UK
  does not tariff coffee". `uktariff_search` therefore drops trailing words
  until something matches and reports `query_used` and `narrowed_to_match`.
- **`/search` is polymorphic.** A numeric query returns
  `{type: "exact_match", entry: {endpoint, id}}` with no result arrays at all.
- **A heading lists each code twice**, once with `producline_suffix` `"10"` (the
  intermediate subheading line) and once with `"80"` (the declarable leaf). They
  carry different descriptions, so without the suffix it looks like contradictory
  duplicates.
- **`/quotas/search` rejects `status=` with a 400** even though every row has a
  status. Filter on year / order_number / area / commodity and read it off.
- **Only `declarable: true` codes** may be used on a customs declaration.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "uk-trade-tariff": {
      "url": "https://gateway.pipeworx.io/uk-trade-tariff/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/uk-trade-tariff/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1684+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/uktariff_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"roasted coffee beans","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/uktariff_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "uk-trade-tariff": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-uk-trade-tariff"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-uk-trade-tariff
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Uk Trade Tariff data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

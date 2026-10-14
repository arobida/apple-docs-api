# Apple Developer Docs API

An agent-friendly HTTP API over Apple's official developer documentation, running as a
Cloudflare Worker. It fetches Apple's docs JSON feed on demand and returns it as clean JSON
or LLM-ready Markdown, with cross-references resolved into linked paths. It also exposes
Apple's own documentation search (the same API developer.apple.com uses).

**Live:** https://apple-docs-api.afrobida.workers.dev

## Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /` | Service index (also `/index.json`, `/llms.txt`) |
| `GET /doc/{path}` | Doc page as clean JSON (`?format=json` default), `?format=markdown` (LLM-ready), or `?format=raw` (Apple original JSON) |
| `GET /doc?url={appleDocUrl}` | Same, by full Apple URL |
| `GET /search?q={query}` | Search Apple docs; add `&type=sample` for sample code |
| `GET /openapi.json` | OpenAPI 3.0 spec |
| `GET /health` | Health check |

### Examples

```bash
curl https://apple-docs-api.afrobida.workers.dev/doc/documentation/swiftui/scene
curl 'https://apple-docs-api.afrobida.workers.dev/doc/documentation/swiftui/scene?format=markdown'
curl 'https://apple-docs-api.afrobida.workers.dev/search?q=SwiftUI%20Scene'
```

## Response notes

- **CORS**: `Access-Control-Allow-Origin: *` — safe to call from any agent or web client.
- **Cache**: responses are cached ~1h at the edge (`cache-control: public, max-age=3600`);
  404s cache 5 minutes, empty searches 10 minutes.
- **JSON model**: `title`, `abstract`, `declarations`, `parameters`, `returns`,
  `availability`, `discussion` (markdown), plus `topicSections` /
  `relationshipsSections` / `seeAlsoSections` with resolvable paths.

## Development

Requires [Node.js](https://nodejs.org/) 22.18+ and a Cloudflare account. This project uses
[cf](https://developers.cloudflare.com/cf/), Cloudflare's CLI, with typed configuration in
`cloudflare.config.ts`.

```bash
npm install
npm run dev        # local dev server (cf dev)
npm run build      # build the worker bundle (cf build)
npm run typecheck  # strict TypeScript check (tsc --noEmit)
npm run deploy     # deploy to Cloudflare (cf deploy)
npm run tail       # stream live logs (wrangler tail)
```

The worker source is TypeScript (`src/index.ts`). Runtime types come from
`@cloudflare/workers-types`; `cf build`/`cf dev` also regenerate `.cloudflare/types/`
from `cloudflare.config.ts` (config-inferred bindings and module types, gitignored). To
write them on demand:

```bash
npm run cf-typegen # cf workers types -> .cloudflare/types/
```

The worker has no bindings — it talks directly to `developer.apple.com` from the edge.

## How it works

1. `/doc/{path}` maps to Apple's JSON feed at
   `https://developer.apple.com/tutorials/data/{path}.json`.
2. The `transform()` function flattens Apple's page model into a clean document object.
3. `toMarkdown()` renders that model as Markdown suitable for LLM context.
4. `/search` calls Apple's internal search API (`devintserv.msc.sbz.apple.com`), replays
   its JSONL diff-event stream, and returns deduplicated results with `api_url` fields
   pointing back at this API's `/doc/{path}`.

## License

MIT

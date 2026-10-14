// MCP (Model Context Protocol) endpoint — exposes this API as tools for AI agents.
// Speaks the current stateless MCP spec (2026-07-28): no session handshake, each
// request carries its own protocol version. Legacy streamable-HTTP clients are
// still served on the same /mcp route via automatic fallback.
// Uses @modelcontextprotocol/server v2 + the Cloudflare agents SDK wrapper.

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import {
  PATH_RE,
  extractPathFromAppleUrl,
  fetchAppleDoc,
  searchDocs,
  toMarkdown,
  transform,
} from './index.ts';

function createServer(): McpServer {
  const server = new McpServer({ name: 'apple-docs-api', version: '1.0.0' });

  server.registerTool(
    'search_docs',
    {
      title: 'Search Apple developer documentation',
      description:
        "Search Apple's official developer documentation (the same index developer.apple.com/search uses). Returns titles, paths and descriptions; pass a result's path to the get_doc tool to read the full page.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search terms, e.g. 'SwiftUI Scene'"),
        type: z
          .enum(['documentation', 'sample'])
          .default('documentation')
          .describe('Search documentation (default) or sample code'),
      }),
    },
    async ({ query, type }) => {
      let out: Awaited<ReturnType<typeof searchDocs>>;
      try {
        out = await searchDocs(query, type);
      } catch (e) {
        out = { upstreamStatus: 0, results: [] };
      }
      const payload = {
        query,
        type,
        results: out.results.map((r) => ({
          title: r.title,
          type: r.type,
          framework: r.framework,
          description: r.description,
          path: r.path,
          url: r.url,
        })),
        hint: out.results.length
          ? "Pass any result's path to the get_doc tool to read the full page."
          : "No results from Apple search. Try different terms, or fetch known pages directly with get_doc (e.g. path 'documentation/swiftui/scene').",
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    }
  );

  server.registerTool(
    'get_doc',
    {
      title: 'Read an Apple developer documentation page',
      description:
        "Fetch a page from Apple's official developer documentation and return it as clean Markdown (default), structured JSON, or Apple's raw JSON. Accepts a developer.apple.com path like 'documentation/swiftui/scene' or a full Apple docs URL.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "developer.apple.com path (e.g. 'documentation/swiftui/scene') or full URL (e.g. 'https://developer.apple.com/documentation/swiftui/scene')"
          ),
        format: z
          .enum(['markdown', 'json', 'raw'])
          .default('markdown')
          .describe(
            "markdown is the most token-efficient for reading; json gives structured fields; raw is Apple's original payload"
          ),
      }),
    },
    async ({ path: input, format }) => {
      let path = extractPathFromAppleUrl(input) ?? input.trim().replace(/^\/+|\/+$/g, '');
      if (path.endsWith('.json')) path = path.slice(0, -5);
      path = path.replace(/\.html$/, '');
      if (!PATH_RE.test(path)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'invalid_path',
                path,
                hint: "Path must start with 'documentation/', 'tutorials/', 'videos/', 'samplecode/' etc. Example: documentation/swiftui/scene",
              }),
            },
          ],
        };
      }
      const upstream = await fetchAppleDoc(path);
      if (upstream.error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error:
                  upstream.error === 'not_found'
                    ? 'not_found — check the path or try the search_docs tool'
                    : upstream.error,
                path,
              }),
            },
          ],
        };
      }
      if (format === 'raw') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(upstream.data) }] };
      }
      const doc = transform(upstream.data, path);
      if (format === 'markdown') {
        return { content: [{ type: 'text' as const, text: toMarkdown(doc) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }] };
    }
  );

  server.registerTool(
    'api_info',
    {
      title: 'About this service',
      description:
        'Describe this API: what it does, its plain-HTTP endpoints, and how to use them. Useful for discovering the REST interface alongside MCP.',
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              name: 'Apple Developer Docs API',
              version: '1.0.0',
              description:
                "Agent-friendly HTTP API + MCP server over Apple's official developer documentation JSON feed (developer.apple.com).",
              http_endpoints: {
                'GET /doc/{path}':
                  'Doc page as JSON (?format=json), Markdown (?format=markdown) or Apple raw JSON (?format=raw). Also: /doc?url=<full Apple URL>',
                'GET /search?q=': 'Search docs; add &type=sample for sample code',
                'GET /openapi.json': 'OpenAPI 3.0 spec',
                'GET /health': 'Health check',
              },
              mcp: 'This endpoint speaks MCP (stateless, spec 2026-07-28) with legacy streamable-HTTP fallback. Tools: search_docs, get_doc, api_info.',
              notes: ['CORS open (*)', 'Responses cached ~1h at the edge'],
            },
            null,
            2
          ),
        },
      ],
    })
  );

  return server;
}

// Handles POST (and OPTIONS) on /mcp. The router in index.ts delegates that path here.
export const handleMcp = createMcpHandler(createServer, { route: '/mcp' });

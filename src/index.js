// Apple Developer Docs API — Cloudflare Worker
// Agent-friendly HTTP API over Apple's official developer documentation JSON feed.

const DATA_BASE = 'https://developer.apple.com/tutorials/data/';
const SITE_BASE = 'https://developer.apple.com/';
const CACHE_TTL = 3600;

const PATH_RE = /^(documentation|tutorials|videos|samplecode|technotes|articles|downloads|release-notes)\//;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': '*',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

function textOut(s, status = 200, contentType = 'text/markdown; charset=utf-8') {
  return new Response(s, { status, headers: { 'content-type': contentType, ...CORS } });
}

// ---------- Apple JSON -> clean model ----------

function refPath(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('doc://')) return null;
  const rest = url.slice('doc://'.length);
  const i = rest.indexOf('/');
  if (i === -1) return null;
  return rest.slice(i + 1);
}

function refTitle(ref) {
  if (!ref) return null;
  if (ref.title) return ref.title;
  if (Array.isArray(ref.fragments)) return ref.fragments.map((f) => f.text || '').join('').trim();
  return null;
}

function inline(items, refs) {
  if (!Array.isArray(items)) return '';
  let out = '';
  for (const it of items) {
    switch (it.type) {
      case 'text':
        out += it.text || '';
        break;
      case 'codeVoice':
        out += '`' + (it.code || '') + '`';
        break;
      case 'reference': {
        const ref = (refs && refs[it.identifier]) || null;
        const title = refTitle(ref) || it.identifier || 'link';
        const p = ref && refPath(ref.url);
        out += p ? '[' + title + '](' + SITE_BASE + p + ')' : title;
        break;
      }
      case 'image': {
        const src = it.rawURL || (it.variants && it.variants[0] && it.variants[0].url) || '';
        out += '![' + (it.alt || 'image') + '](' + src + ')';
        break;
      }
      case 'emphasis':
      case 'newTerm':
        out += '*' + inline(it.inlineContent, refs) + '*';
        break;
      case 'strong':
        out += '**' + inline(it.inlineContent, refs) + '**';
        break;
      default:
        if (it.inlineContent) out += inline(it.inlineContent, refs);
        else if (it.text) out += it.text;
    }
  }
  return out;
}

function indentBlock(text) {
  return String(text || '')
    .trim()
    .split('\n')
    .map((l, i) => (i === 0 ? l : '  ' + l))
    .join('\n');
}

function blocks(items, refs) {
  if (!Array.isArray(items)) return '';
  let out = '';
  for (const it of items) {
    switch (it.type) {
      case 'heading': {
        const lvl = Math.min(Math.max(it.level || 2, 1), 6);
        out += '\n\n' + '#'.repeat(lvl) + ' ' + (it.text || '') + '\n\n';
        break;
      }
      case 'paragraph':
        out += inline(it.inlineContent, refs) + '\n\n';
        break;
      case 'codeListing': {
        const code = Array.isArray(it.code) ? it.code.join('\n') : it.code || '';
        out += '\n```' + (it.syntax || '') + '\n' + code + '\n```\n\n';
        break;
      }
      case 'unorderedList': {
        const lines = (it.items || []).map((li) => '- ' + indentBlock(blocks(li.content, refs)));
        out += lines.join('\n') + '\n\n';
        break;
      }
      case 'orderedList': {
        const lines = (it.items || []).map((li, i) => i + 1 + '. ' + indentBlock(blocks(li.content, refs)));
        out += lines.join('\n') + '\n\n';
        break;
      }
      case 'aside': {
        const title = it.title || 'Note';
        const body = String(blocks(it.content, refs)).trim();
        out += '\n> **' + title + ':** ' + body.replace(/\n+/g, '\n> ') + '\n\n';
        break;
      }
      case 'termList': {
        for (const t of it.items || []) {
          out += '- **' + inline(t.term, refs) + '**: ' + inline(t.definition, refs) + '\n';
        }
        out += '\n';
        break;
      }
      case 'links': {
        for (const l of it.items || []) out += '- ' + inline([l], refs) + '\n';
        out += '\n';
        break;
      }
      case 'tabularData': {
        const headers = (it.headers || []).map((h) => (typeof h === 'string' ? h : inline([h], refs)));
        if (headers.length) {
          out += '\n| ' + headers.join(' | ') + ' |\n';
          out += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
          for (const row of it.rows || []) out += '| ' + row.map((c) => String(c)).join(' | ') + '|\n';
          out += '\n';
        }
        break;
      }
      default:
        if (it.inlineContent) out += inline(it.inlineContent, refs) + '\n\n';
    }
  }
  return out;
}

function renderTokens(tokens) {
  return (tokens || []).map((t) => t.text || '').join('').trim();
}

function mapPlatforms(list) {
  return (list || []).map((p) => ({
    platform: p.name,
    introducedAt: p.introducedAt || null,
    deprecatedAt: p.deprecatedAt || null,
    deprecated: !!p.deprecated,
    beta: !!p.beta,
    unavailable: !!p.unavailable,
  }));
}

function resolveSection(sec, refs) {
  const items = (sec.identifiers || [])
    .map((id) => {
      const ref = (refs && refs[id]) || null;
      const p = ref && refPath(ref.url);
      return {
        title: refTitle(ref) || id,
        path: p,
        url: p ? SITE_BASE + p : null,
        abstract: ref && ref.abstract ? inline(ref.abstract, refs) : null,
      };
    })
    .filter((x) => x.path);
  return { title: sec.title || '', items };
}

function transform(data, path) {
  const refs = data.references || {};
  const meta = data.metadata || {};

  const doc = {
    title: meta.title || '',
    roleHeading: meta.roleHeading || null,
    symbolKind: meta.symbolKind || null,
    kind: data.kind || null,
    path,
    url: SITE_BASE + path,
    sourceLanguage: (data.identifier && data.identifier.interfaceLanguage) || null,
    abstract: Array.isArray(data.abstract) ? inline(data.abstract, refs) : null,
    availability: mapPlatforms(meta.platforms),
    deprecated:
      !!(data.deprecationSummary && data.deprecationSummary.length) ||
      (meta.platforms || []).some((p) => p.deprecated),
    deprecationSummary: Array.isArray(data.deprecationSummary)
      ? inline(data.deprecationSummary, refs)
      : null,
    declarations: [],
    parameters: [],
    returns: null,
    discussion: '',
    topicSections: [],
    relationshipsSections: [],
    seeAlsoSections: [],
  };

  for (const sec of data.primaryContentSections || []) {
    switch (sec.kind) {
      case 'declarations':
        for (const d of sec.declarations || []) {
          doc.declarations.push({
            language: (d.languages || [])[0] || 'swift',
            code: renderTokens(d.tokens),
          });
        }
        break;
      case 'parameters':
        doc.parameters = (sec.parameters || []).map((p) => ({
          name: p.name || '',
          content: inline(p.content, refs),
        }));
        break;
      case 'returns':
        doc.returns = inline(sec.content, refs);
        break;
      case 'content':
        doc.discussion += blocks(sec.content, refs);
        break;
      default:
        // 'mentions', 'attachments', etc. are skipped
        break;
    }
  }

  doc.discussion = doc.discussion.trim();
  doc.topicSections = (data.topicSections || []).map((s) => resolveSection(s, refs));
  doc.relationshipsSections = (data.relationshipsSections || []).map((s) => resolveSection(s, refs));
  doc.seeAlsoSections = (data.seeAlsoSections || []).map((s) => resolveSection(s, refs));
  return doc;
}

function toMarkdown(doc) {
  let m = '# ' + doc.title + '\n\n';
  if (doc.roleHeading) m += '_Role: ' + doc.roleHeading + '_\n\n';
  const avail = (doc.availability || []).filter((p) => !p.unavailable);
  if (avail.length) {
    m +=
      '**Availability:** ' +
      avail.map((p) => p.platform + (p.introducedAt ? ' ' + p.introducedAt + '+' : '')).join(', ') +
      '\n\n';
  }
  if (doc.deprecated) {
    m += '> ⚠️ **Deprecated**' + (doc.deprecationSummary ? ': ' + doc.deprecationSummary : '') + '\n\n';
  }
  if (doc.abstract) m += doc.abstract + '\n\n';
  if (doc.declarations.length) {
    m += '## Declaration\n\n';
    for (const d of doc.declarations) m += '```' + (d.language || 'swift') + '\n' + d.code + '\n```\n\n';
  }
  if (doc.parameters.length) {
    m += '## Parameters\n\n';
    for (const p of doc.parameters) m += '- **' + p.name + '**: ' + p.content + '\n';
    m += '\n';
  }
  if (doc.returns) m += '## Returns\n\n' + doc.returns + '\n\n';
  if (doc.discussion) m += doc.discussion + '\n\n';

  const sectionGroups = [
    ['Topics', doc.topicSections],
    ['Relationships', doc.relationshipsSections],
    ['See Also', doc.seeAlsoSections],
  ];
  for (const [name, groups] of sectionGroups) {
    const valid = (groups || []).filter((g) => g.items.length);
    if (!valid.length) continue;
    m += '## ' + name + '\n\n';
    for (const g of valid) {
      if (g.title) m += '### ' + g.title + '\n\n';
      for (const item of g.items) m += '- [' + item.title + '](' + item.url + ')\n';
      m += '\n';
    }
  }
  m += '---\n[View on developer.apple.com](' + doc.url + ')\n';
  return m;
}

// ---------- upstream fetching ----------

async function fetchAppleDoc(path) {
  const candidates = [path];
  const lower = path.toLowerCase();
  if (lower !== path) candidates.push(lower);

  let lastStatus = null;
  for (const c of candidates) {
    const u = DATA_BASE + c + '.json';
    let res;
    try {
      res = await fetch(u, { headers: { accept: 'application/json' } });
    } catch (e) {
      return { error: 'upstream_unreachable' };
    }
    lastStatus = res.status;
    if (res.ok) {
      try {
        const data = await res.json();
        return { data, fetchedPath: c };
      } catch (e) {
        return { error: 'upstream_invalid_json' };
      }
    }
    if (res.status !== 404) break;
  }
  return { error: lastStatus === 404 ? 'not_found' : 'upstream_error_' + lastStatus };
}

// ---------- search (Apple's search API — the same one developer.apple.com/search uses) ----------

const SEARCH_API = 'https://devintserv.msc.sbz.apple.com/api/v1/query';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const KIND_TYPES = { article: 'documentation-article', tutorial: 'documentation-tutorial', sampleCode: 'sample-code' };

async function searchDocs(q, scope) {
  const searchScope =
    scope === 'sample'
      ? { kind: 'documentationRole', value: 'sampleCode' }
      : {
          kind: 'and',
          scopes: [
            { kind: 'hostname', value: 'developer.apple.com' },
            { kind: 'pathPrefix', value: '/documentation/' },
          ],
        };

  const res = await fetch(SEARCH_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/jsonl',
      'user-agent': SAFARI_UA,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      text: q,
      targetResultLocale: 'en',
      includedResponses: ['search'],
      searchScope,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return { upstreamStatus: res.status, results: [] };

  // The API streams JSON-lines diff events; replay them to build the results document.
  const jsonl = await res.text();
  let doc = '';
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.kind === 'search' && ev.diff) {
        const append = ev.diff.append || '';
        const removeLast = ev.diff.removeLast || 0;
        doc = doc.slice(0, Math.max(0, doc.length - removeLast)) + append;
      }
    } catch (e) {
      /* skip malformed line */
    }
  }

  let apiResults = [];
  try {
    apiResults = doc ? JSON.parse(doc).results || [] : [];
  } catch (e) {
    apiResults = [];
  }

  const results = [];
  const seen = new Set();
  for (const r of apiResults) {
    const md = (r && r.value && r.value.metadata) || {};
    const title = md.title;
    const permalink = md.permalink;
    if (!title || !permalink) continue;
    if (!permalink.includes('/documentation/')) continue;
    if (permalink.includes('.zip') || permalink.includes('download.apple.com')) continue;
    const url = permalink.split('#')[0].split('?')[0].replace(/\/+$/, '');
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      title,
      type: KIND_TYPES[md.kind || ''] || 'documentation',
      description: md.description || null,
      framework: (md.hierarchy || '').split(' > ')[0] || null,
      url,
      path: url.startsWith('https://developer.apple.com/')
        ? url.slice('https://developer.apple.com/'.length)
        : url,
    });
    if (results.length >= 20) break;
  }
  return { upstreamStatus: res.status, results };
}

// ---------- cache helpers ----------

async function cacheGet(request) {
  try {
    return await caches.default.match(request);
  } catch (e) {
    return null;
  }
}

function cachePut(request, response, ctx) {
  try {
    const r = new Response(response.body, response);
    r.headers.set('cache-control', 'public, max-age=' + CACHE_TTL);
    ctx.waitUntil(caches.default.put(request, r));
  } catch (e) {
    /* cache unavailable on workers.dev — ignore */
  }
}

// ---------- index / openapi ----------

function serviceIndex(origin) {
  return {
    name: 'Apple Developer Docs API',
    version: '1.0.0',
    description:
      'Agent-friendly HTTP API over App developer documentation (developer.apple.com). Fetches Apple official docs JSON feed on demand and returns it as clean JSON or Markdown, with references resolved into linked paths.',
    base_url: origin,
    endpoints: {
      'GET /doc/{path}': {
        description:
          'Get a doc page as clean JSON or Markdown. path is the developer.apple.com path without the domain, e.g. /doc/documentation/swiftui/scene',
        params: {
          format: 'json (default) | markdown | raw (Apple original JSON)',
        },
        examples: [
          origin + '/doc/documentation/swiftui/scene',
          origin + '/doc/documentation/swiftui/scene?format=markdown',
        ],
      },
      'GET /doc?url={appleDocUrl}': 'Get a doc page by full Apple URL, e.g. ?url=https://developer.apple.com/documentation/swiftui/scene',
      'GET /search?q={query}': {
        description:
          'Search Apple developer documentation via the same search API developer.apple.com uses. Returns matching paths that can be fetched with /doc/{path}. Add &type=sample for sample code.',
        example: origin + '/search?q=SwiftUI%20Scene',
      },
      'GET /openapi.json': 'OpenAPI 3.0 spec for this API',
      'GET /health': 'Health check',
    },
    response_notes: {
      json: 'Structured fields: title, abstract, declarations, parameters, returns, availability, discussion (markdown), topicSections/relationshipsSections/seeAlsoSections with resolvable paths.',
      cors: 'Access-Control-Allow-Origin: * — safe to call from any agent or web client.',
      cache: 'Responses cached ~1h at the edge.',
    },
  };
}

function openapiSpec(origin) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Apple Developer Docs API',
      version: '1.0.0',
      description: 'Agent-friendly API over Apple developer documentation.',
    },
    servers: [{ url: origin }],
    paths: {
      '/doc/{path}': {
        get: {
          summary: 'Get a documentation page',
          description:
            'path is the developer.apple.com URL path, e.g. documentation/swiftui/scene. Supports ?format=json|markdown|raw.',
          parameters: [
            {
              name: 'path',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              example: 'documentation/swiftui/scene',
            },
            {
              name: 'format',
              in: 'query',
              schema: { type: 'string', enum: ['json', 'markdown', 'raw'], default: 'json' },
            },
          ],
          responses: {
            '200': { description: 'Documentation page' },
            '404': { description: 'Path not found' },
          },
        },
      },
      '/doc': {
        get: {
          summary: 'Get a documentation page by URL or path query param',
          parameters: [
            { name: 'url', in: 'query', schema: { type: 'string' }, description: 'Full developer.apple.com URL' },
            { name: 'path', in: 'query', schema: { type: 'string' }, description: 'Apple docs path' },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'markdown', 'raw'] } },
          ],
          responses: { '200': { description: 'Documentation page' } },
        },
      },
      '/search': {
        get: {
          summary: 'Search Apple developer documentation',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            {
              name: 'type',
              in: 'query',
              schema: { type: 'string', enum: ['documentation', 'sample'], default: 'documentation' },
            },
          ],
          responses: { '200': { description: 'Search results with resolvable paths' } },
        },
      },
      '/health': {
        get: {
          summary: 'Health check',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
}

// ---------- router ----------

function extractPathFromAppleUrl(u) {
  const m = /^https?:\/\/developer\.apple\.com\/([^\s?#]+)/i.exec(u || '');
  return m ? m[1].replace(/\/+$/, '') : null;
}

async function handleDoc(request, url, ctx) {
  const format = (url.searchParams.get('format') || 'json').toLowerCase();

  let path = null;
  if (url.searchParams.get('url')) path = extractPathFromAppleUrl(url.searchParams.get('url'));
  else if (url.searchParams.get('path')) path = url.searchParams.get('path').replace(/^\/+|\/+$/g, '');
  else if (url.pathname.length > '/doc/'.length)
    path = url.pathname.slice('/doc/'.length).replace(/\/+$/, '');

  if (!path || !PATH_RE.test(path)) {
    return json(
      {
        error: 'invalid_path',
        hint: "Path must start with 'documentation/', 'tutorials/', 'samplecode/' etc. Example: /doc/documentation/swiftui/scene",
      },
      400
    );
  }
  if (path.endsWith('.json')) path = path.slice(0, -5);
  path = path.replace(/\.html$/, '');
  // Decode percent-encoded segments (e.g. datatask%28with%3A%29 -> datatask(with:))
  try {
    path = path
      .split('/')
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch (e) {
          return seg;
        }
      })
      .join('/');
  } catch (e) {
    /* keep original */
  }

  const cached = await cacheGet(request);
  if (cached) return cached;

  const upstream = await fetchAppleDoc(path);
  if (upstream.error === 'not_found') {
    return json(
      { error: 'not_found', path, hint: 'Check the path or use /search?q= to find it.' },
      404,
      { 'cache-control': 'public, max-age=300' }
    );
  }
  if (upstream.error) {
    return json({ error: upstream.error, path }, 502, { 'cache-control': 'no-store' });
  }

  const data = upstream.data;
  let response;
  if (format === 'raw') {
    response = json(data, 200, { 'cache-control': 'public, max-age=' + CACHE_TTL });
  } else if (format === 'markdown' || format === 'md' || format === 'text') {
    const md = toMarkdown(transform(data, path));
    response = new Response(md, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8', ...CORS, 'cache-control': 'public, max-age=' + CACHE_TTL },
    });
  } else {
    const doc = transform(data, path);
    doc.api = { format: 'json', tip: 'append ?format=markdown for LLM-ready markdown, ?format=raw for Apple original JSON' };
    response = json(doc, 200, { 'cache-control': 'public, max-age=' + CACHE_TTL });
  }
  cachePut(request, response.clone(), ctx);
  return response;
}

async function handleSearch(request, url, ctx) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ error: 'missing_query', hint: 'Provide ?q=<search terms>' }, 400);
  const type = (url.searchParams.get('type') || 'documentation').toLowerCase();
  if (type !== 'documentation' && type !== 'sample') {
    return json({ error: 'invalid_type', hint: 'type must be documentation (default) or sample' }, 400);
  }

  const cached = await cacheGet(request);
  if (cached) return cached;

  let out;
  try {
    out = await searchDocs(q, type);
  } catch (e) {
    out = { upstreamStatus: 0, results: [] };
  }
  if (!out.results.length) {
    const body = {
      query: q,
      type,
      results: [],
      note:
        'No results from Apple search. Try different terms, or fetch pages directly with /doc/{path}.',
    };
    return json(body, out.upstreamStatus && out.upstreamStatus >= 400 ? 502 : 200, {
      'cache-control': 'public, max-age=600',
    });
  }
  const body = {
    query: q,
    type,
    results: out.results.map((r) => ({
      title: r.title,
      type: r.type,
      framework: r.framework,
      description: r.description,
      path: r.path,
      url: r.url,
      api_url: new URL(request.url).origin + '/doc/' + r.path,
    })),
    hint: 'Fetch any result via GET /doc/{path}',
  };
  const response = json(body, 200, { 'cache-control': 'public, max-age=' + CACHE_TTL });
  cachePut(request, response.clone(), ctx);
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed', hint: 'Only GET is supported.' }, 405);
    }

    const origin = url.origin;

    if (url.pathname === '/' || url.pathname === '/index.json' || url.pathname === '/llms.txt') {
      return json(serviceIndex(origin));
    }
    if (url.pathname === '/openapi.json') {
      return json(openapiSpec(origin));
    }
    if (url.pathname === '/health') {
      return json({ status: 'ok', upstream: 'developer.apple.com', time: new Date().toISOString() });
    }
    if (url.pathname === '/search') {
      return handleSearch(request, url, ctx);
    }
    if (url.pathname === '/doc' || url.pathname.startsWith('/doc/')) {
      return handleDoc(request, url, ctx);
    }

    return json(
      {
        error: 'not_found',
        available_endpoints: ['/', '/doc/{path}', '/doc?url=', '/search?q=', '/openapi.json', '/health'],
      },
      404
    );
  },
};

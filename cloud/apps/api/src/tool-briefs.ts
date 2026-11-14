import type {FeatureTool} from './contracts.js';

/** Reviewed usage briefs. Remote schemas remain authoritative; these never invent arguments. */
export const TOOL_BRIEFS: Record<string,Record<string,string>> = {
  'builtin-exa': {
    web_search_exa:'Find web sources; query, numResults. Keep results small; cite URLs; search credits apply.',
    web_fetch_exa:'Read a known URL; url. Prefer this over repeated searches; retrieval credits apply.',
    web_search_advanced_exa:'Search with filters; query, category, dates. Use only needed filters; credits apply.',
    agent_run:'Research multiple sources; task. Slower and more costly than search; requires authentication.',
  },
  'builtin-firecrawl': {
    firecrawl_search:'Find sources; query, limit. Keep limit small; search credits apply.',
    firecrawl_scrape:'Read one URL; url, formats. Prefer markdown; JSON for extraction; credits per page.',
    firecrawl_parse:'Read a document; url. Limit output to needed content; credits apply.',
    firecrawl_map:'Discover URLs; url, search, limit. Map before crawling; bound the limit.',
    firecrawl_crawl:'Traverse a site; url, limit. Set a small page limit; returns a job; credits per page.',
    firecrawl_check_crawl_status:'Read a crawl job; id. Poll sparingly; do not start another crawl.',
    firecrawl_find_tools:'Discover typed provider contracts; query. Authentication and provider terms may apply.',
    firecrawl_agent:'Research unknown sources; prompt, urls. Costlier than scrape; returns a job.',
    firecrawl_agent_status:'Read research job; id. Poll sparingly.',
    firecrawl_interact:'Use a dynamic page; url, actions. Session costs apply; close with interact_stop.',
    firecrawl_interact_stop:'Close a browser session; sessionId. Release it when finished.',
  },
  'builtin-e2b': {run_code:'Execute Python or JavaScript; code, language. Temporary Linux sandbox, 50s limit; paid compute; return compact results.'},
  'builtin-browserbase': {
    start:'Create hosted browser session. Paid browser time; end when finished.',
    end:'Release hosted browser; sessionId. Always close sessions you create.',
    navigate:'Open URL in browser; sessionId, url. Prefer scrape for static pages.',
    observe:'Inspect interactive page; sessionId. Observe before acting; browser time applies.',
    act:'Interact with page; sessionId, action. Check effects; browser time applies.',
    extract:'Extract page data; sessionId, schema. Request only needed fields; browser time applies.',
  },
};
export function briefTool(tool:FeatureTool):FeatureTool {
  const raw=tool.originalName ?? tool.name;
  const curated=TOOL_BRIEFS[tool.source.serverId ?? '']?.[raw];
  const fallback=tool.description.replace(/\s+/g,' ').trim().slice(0,130);
  const properties=tool.inputSchema.properties;
  const keys=properties&&typeof properties==='object'&&!Array.isArray(properties)?Object.keys(properties).slice(0,3):[];
  return {...tool,description:curated ?? fallback+(keys.length?' Args: '+keys.join(', ')+'.':'')};
}

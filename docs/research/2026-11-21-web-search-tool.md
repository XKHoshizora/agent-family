# Research: a web search tool for Agent Family

Read dates: all sources below were read on 2026-11-21 (WebFetch / WebSearch). "Primary" means the vendor's own documentation or pricing page. Anything from blogs, news or aggregator pages is marked "unverified (secondary)". Prices are USD unless stated. Nothing here was tested by running a call.

Reading note: several vendor docs moved domains (OpenAI to developers.openai.com, Google AI to aistudio.google.com/docs). The fetch tool summarises pages with a small model, so exact wording and numbers should be re-checked on the page before they go into a budget.

---

## 1. How mature products give a chat model web access

### 1.1 Summary table

| Provider | Who runs the search | Price (primary) | Citations | Domain filters | Search text counts as input tokens? |
|---|---|---|---|---|---|
| OpenAI `web_search` (Responses API) | Provider (server-side tool) | $10 per 1,000 calls; plus search content tokens at model rates (fixed 8,000-token block per call for gpt-4o-mini / gpt-4.1-mini) | `url_citation` annotations (url, title, start/end index); `sources` list optional | Up to 100 allowed or 100 blocked domains | Yes, at model rates |
| OpenAI `web_search_preview` (legacy) | Provider | Reasoning models: $10 per 1,000 + tokens. Other models: $25 per 1,000, search tokens free | Same shape | Not supported | Depends on model (see left) |
| OpenAI Chat Completions | Provider | Only `gpt-5-search-api`, always searches | In message | n/a | n/a |
| Anthropic `web_search` | Provider (server tool) | $10 per 1,000 searches plus standard tokens; failed search not billed | Always on; `web_search_result_location` with url, title, up to 150 chars `cited_text`; cited_text/title/url fields do not count as tokens | `allowed_domains` or `blocked_domains` (not both); `max_uses` per turn | Yes, results count as input tokens (also on later turns) |
| Anthropic `web_fetch` | Provider (server tool) | No extra charge, tokens only | Optional (`citations.enabled`) | allowed/blocked domains (domain-level only) | Yes (about 2,500 tokens for a 10 kB page; `max_content_tokens` caps it) |
| Google Gemini "Grounding with Google Search" | Provider | Gemini 3+: first 5,000 search requests per month free (shared), then $14 per 1,000 search queries executed; older models billed per prompt (rate not on the page) | `url_citation` annotations plus `search_suggestions` HTML | Not stated on page | Not stated |
| xAI Web Search | Provider (server-side tool) | $5 per 1,000 calls (pricing page); plus normal tokens | `response.citations` / sources | `allowed_domains` or `excluded_domains`, max 5 each, not together | Tokens charged normally (page says tool requests cost tokens plus tool invocations) |
| Perplexity Search API | Provider (it is a search API, caller feeds the model) | $5 per 1,000 requests; $1 per 1,000 with `search_type: "fast"`; no token charge; one request can carry up to 5 queries | Result list (title, url, snippet, date) | not checked | No tokens charged by the API itself |
| Perplexity Agent API `web_search` tool | Provider | $2.50 per 1,000 (standard) or $1.00 (fast), plus model tokens; `fetch_url` tool $0.0005 per call | `search_results` item in output | not checked | Model tokens separate |
| Perplexity Sonar (chat) | Provider | Per-token plus request fee that varies by context size; amounts not on the pages I could read (secondary sources disagree: unverified) | top-level `citations` and `search_results` | not checked | n/a |
| DeepSeek `deepseek_web_search` / `deepseek_read_url` | Provider | Until 2026-11-18: $0.75 per 1,000 successful calls (Search and Fetch). From 2026-11-18 12:00 Beijing time: not billed separately, results count as model input tokens | `citations` on text blocks pointing at result URLs; results carry title, URL, snippet, site name, page age | Not described | Yes, from 2026-11-18 |
| OpenRouter `:online` / `web` plugin | Provider-native if the model has it, otherwise Exa (engine selectable) | Exa $0.007 per request (10 results; +$0.001 per extra result); Parallel $0.001-$0.005; Firecrawl $0.005 + $0.0125 per result; Perplexity $0.005; native = pass-through | `url_citation` annotations (OpenAI chat format) | `include_domains` / `exclude_domains`, wildcards and paths; support varies by engine | Result text is added to the prompt (the plugin injects it), so it is billed as input tokens: inference from the docs, not stated verbatim |

### 1.2 Details per provider

**OpenAI.** Source: https://developers.openai.com/api/docs/guides/tools-web-search and https://developers.openai.com/api/docs/pricing (read 2026-11-21).
- Add `{ "type": "web_search" }` to `tools` in a Responses API request. The model decides whether to search; `tool_choice: "required"` forces it. The response contains `web_search_call` items whose action is `search`, `open_page` or `find_in_page` (the last two only for reasoning models).
- The page says that when you show web results you "must show inline citations as prominent, clickable links".
- `search_context_size` low/medium/high; search context is capped at 128k tokens; `external_web_access: false` gives cache-only mode.
- `gpt-4o-search-preview` and `gpt-4o-mini-search-preview` are listed as deprecated with shutdown 2026-07-23 (already past on the date I read it). For Chat Completions only `gpt-5-search-api` is listed.
- The page does not say how many searches a single reply may run; search uses the model's normal rate limits.

**Anthropic.** Sources: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool , .../web-fetch-tool , .../server-tools (read 2026-11-21).
- Search is a server tool: the API runs it inside the request. `max_uses` caps searches per turn (failed ones count). Domain filter entries are bare domains, subdomains included, paths allowed for search. Doc warns that Unicode homograph domains can bypass filters; use ASCII-only entries.
- Citations: "When displaying API outputs directly to end users, citations must be included to the original source." Reprocessed or combined output: consult legal.
- Web fetch security warning (primary): enabling fetch where Claude processes untrusted input alongside sensitive data poses data exfiltration risk. Mitigations the doc lists: only fetch URLs that already appeared in the conversation (not URLs only in the model's own output), refuse URLs that look like they contain credentials, `max_uses`, `allowed_domains`, `url_sources` to stop tool results counting as a source. The fetch tool also refuses `robots.txt`-blocked URLs and private addresses (listed under `url_not_allowed`). It does not render JavaScript.
- Only text, HTML and PDF content types are supported by the fetch tool.

**Google.** Sources: https://aistudio.google.com/docs/google-search and https://aistudio.google.com/docs/terms (read 2026-11-21).
- Billed per search query the model executes (Gemini 3+). Default 1,500 requests per day per project on paid tier (page states this).
- Gemini 3 and 4 models can combine Google Search with function calling.
- Terms (primary, summary of the page): show grounded results with their Search Suggestions only to the end user who sent the prompt; do not alter or mix other content into them without written permission; do not cache, syndicate, analyse or train on them; limited storage allowed (result text up to two years for showing a user their own chat history, and temporarily for refining via function call; up to five suggestions or links must accompany the final result); click tracking of suggestions or links is prohibited.

**xAI.** Sources: https://docs.x.ai/docs/guides/tools/search-tools , https://docs.x.ai/developers/pricing (read 2026-11-21). Web Search $5 per 1,000 calls; X Search billed per item ($5 per 1,000 posts); domain filters max 5 and exclusive of each other. The page does not list rate limits or the full model list.

**Perplexity.** Sources: https://docs.perplexity.ai/docs/getting-started/pricing.md , https://docs.perplexity.ai/docs/sonar/quickstart (read 2026-11-21). The Sonar page states Sonar Chat Completions support ends 2026-09-27 and requests are being reformulated as Agent API requests (the date is already past; the page says the move is gradual, so treat Sonar as legacy). The Search API is a plain search endpoint, so it can serve a self-run tool.

**DeepSeek.** Sources: https://api-docs.deepseek.com/guides/build_a_chatbot and https://api-docs.deepseek.com/quick_start/pricing (read 2026-11-21).
- Yes, the API now offers search and URL reading as server tools: declare `deepseek_web_search` and/or `deepseek_read_url` in Messages (`/anthropic/v1/messages`), Responses or Chat Completions. Model named on the page: `deepseek-flash`. Results come back as `web_search_tool_result` (title, URL, snippet, site name, icon, page age) and text blocks with `citations`. Many sampling parameters are ignored when these tools are declared.
- Pricing page: Search API and Fetch API $0.75 per 1,000 successful requests; since 2026-11-18 12:00 Beijing time, calls triggered by the model are not billed separately and results count as input tokens. Token prices on that page: deepseek-flash input cache-miss $0.15 / $0.30 per 1M (off-peak / peak), output $0.60 / $1.20.
- The page says public-facing services must handle their own content review, registration and AI labelling (Chinese regulatory wording, summary of the page).
- Not on the page: numeric search limits, domain filters. Secondary sources (eesel.ai, webpronews, SMM) mention a 5 QPS per account limit and disagree on which models support search: unverified.
- Practical meaning for the gateway: DeepSeek's server-side search has a shape of its own (Anthropic-style blocks), so it cannot be treated as the same thing as OpenAI's `web_search`.

**OpenRouter.** Source: https://openrouter.ai/docs/features/web-search (read 2026-11-21). `:online` on a slug equals the `web` plugin. Engines: native, exa, firecrawl, parallel, perplexity; unspecified means native if the provider supports it, else Exa. `max_results` default 5. Annotations in OpenAI `url_citation` format. Doc states extra cost applies even for free models. Google native search does not support domain filtering, and OpenAI native ignores `exclude_domains` (page statements).

### 1.3 What this shows
- Every large provider has its own server-side tool with its own request shape and response blocks. None is portable. Per-search prices cluster at $5 (xAI, Perplexity Search API) and $10 (OpenAI, Anthropic), $14 (Google after a free allowance), with DeepSeek the outlier (now tokens only).
- Search text is counted as input tokens everywhere it is stated (OpenAI, Anthropic, DeepSeek). The search fee is only part of the cost.
- Every provider shows citations as structured data the caller is expected to render.

---

## 2. Independent search APIs a self-run tool could call

| API | Price (primary unless marked) | Free tier | Rate limit | Result shape | Fetch/clean page? |
|---|---|---|---|---|---|
| Brave Search API | Search $5 per 1,000 requests; Answers $4 per 1,000 + $5 per 1M tokens (https://brave.com/search/api/) | $5 free credit per month on the cards; hero text says "up to $20 free calls": page does not reconcile | Search 50 QPS, Answers 2 QPS | Title, URL, snippet; `extra_snippets` up to 5 extras; LLM Context endpoint returns pre-extracted page chunks (token budget 1,024-32,768, default 8,192); pricing for LLM Context not on the page I read | LLM Context gives page content for the results; no separate fetch endpoint seen |
| Tavily | 1 credit per basic search, 2 per advanced; extract: 5 URLs per credit (basic); plans $30 per 4,000 credits up to $500 per 100,000; pay-as-you-go $0.008 per credit (https://docs.tavily.com/documentation/api-credits) | 1,000 credits per month, no card | numeric limits not on the pages (429/432/433 codes documented) | Title, URL, `content` snippet (about 500 chars chunks), score; optional `raw_content` markdown, optional LLM answer | Yes: Extract, Crawl, Map, `include_raw_content` |
| Exa | Search $4 per 1,000 (lite/instant), $7 (auto/fast), $12 (deep), $15 (deep-reasoning), 10 results included; contents $1 per 1,000 pages (https://exa.ai/pricing) | $10 credit per month on new accounts | Not listed publicly (Enterprise 25 QPS) | Results plus optional text/highlights/summary | Yes (contents endpoint) |
| Serper | Not on the pages I could read (serper.dev/pricing returned 404). Secondary sources: $50 for 50,000 credits (about $1 per 1,000), 2,500 free queries: unverified (secondary) | 2,500 free queries per the home page (primary) | unverified | JSON: organic, peopleAlsoAsk, knowledgeGraph, news, etc. (Google SERP) | No (SERP only) |
| SerpApi | Free 250 searches/month; $25 per 1,000 searches/month; $75 per 5,000; $150 per 15,000 (https://serpapi.com/pricing) | 250 per month | Free 50/hour; Starter 200/hour | Google SERP JSON | No |
| Bing Search API | Retired 2025-08-11; Microsoft points to "Grounding with Bing Search" in Azure AI Agents (https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement). Replacement price: secondary sources say $35 or $14 per 1,000: unverified | none | n/a | Replacement does not give raw search results to the caller (secondary, Neowin via search summary: unverified) | n/a |
| Google Programmable Search (Custom Search JSON API) | 100 queries per day free, then $5 per 1,000 up to 10k per day; page says closed to new customers, existing customers must move by 2027-01-01 (https://developers.google.com/custom-search/v1/overview) | 100 per day | 10k per day | JSON | No |
| Firecrawl | Search 2 credits per 10 results; scrape 1 credit per page; plans Free (1,000 credits) to Scale $749 for 1,000,000 credits (https://www.firecrawl.dev/pricing, https://docs.firecrawl.dev/features/search) | 1,000 credits (about 500 searches), no card | `/search` 10 RPM free, 100 Hobby, 500 Standard | title, url, description; with `scrapeOptions` also markdown | Yes: scrape, crawl, search-with-scrape |
| Jina (s.jina.ai / r.jina.ai) | Reader: free without key (20 RPM); with key tokens by output size. Search: fixed charge starting at 10,000 tokens per request; top 5 results with LLM-friendly text (https://jina.ai/reader/). Token price not on the page | 10M free tokens per new key; Search needs a key | Reader 20 RPM no key; Search 100 RPM with free key | URL, title, content (full page text) | Yes: r.jina.ai is the fetch-and-clean endpoint; page states average latency about 7.9 s for Reader and 2.5 s for Search |
| Kagi | Search $12 per 1,000 requests; Extract $4 per 1,000 pages (https://kagi.com/api/pricing) | none seen | not seen | not checked | Yes, Extract |
| You.com | Web Search API $5 per 1,000 calls; Extract Lite $0.90 per 1,000 URLs; 1-10 s per URL (https://you.com/pricing) | $10 credit (about 2,000 searches); MCP free tier 100 queries per day | not public | not checked | Yes, Extract |
| Bocha (Chinese market) | Price not on the page I could read (https://open.bochaai.com/) | not stated | not stated | `name`, `url`, `siteName`, `snippet`, `summary` (with `summary:true`), `datePublished`; examples all in Chinese | no separate fetch seen |
| Zhipu (bigmodel.cn) Web Search | 0.01 yuan per call (search_std), 0.03 (search_pro), 0.05 (search_pro_sogou or search_pro_quark) (https://docs.bigmodel.cn/cn/guide/tools/web-search) | not stated | not stated | title, url, content/summary, site name, publish date | no |
| DeepSeek Search API (via model tool only?) | see 1.2; not confirmed as a standalone caller API | n/a | n/a | n/a | URL reading as a model tool |

### 2.1 Language coverage for Chinese and Japanese (what could and could not be verified)
- No primary or independent source I found measures Chinese or Japanese result quality for Brave, Tavily, Exa, Serper, Firecrawl or Jina. A web search for CJK benchmarks returned only vendor-written comparisons and English-language tests; a Serverworks blog compared Tavily and Brave from Japan on mostly English technical queries (https://blog.serverworks.co.jp/tavily-vs-brave-search-api-comparison, secondary, one small test). So CJK quality is unverified for all of them. A small own test (about 30 zh, ja, en queries per candidate) is the only way to know.
- Parameters that exist: Brave has `country` and `search_lang`; the page I read did not list valid values for zh/ja (https://api-dashboard.search.brave.com/app/documentation/web-search/query). Tavily has `language` (ISO 639-1 such as `zh-cn`, boosts or with `filter_by_language` filters) and `country` (https://docs.tavily.com/documentation/api-reference/endpoint/search). Firecrawl search page lists `location` but no `lang`. Jina Reader returns text in the page's original language.
- Serper and SerpApi return Google results, so CJK coverage should follow Google's, but that is an inference, not a source statement.
- Bocha and Zhipu are built for the Chinese web (examples all Chinese); neither page mentions Japanese or English.
- Brave's own Chinese and Japanese marketing pages exist (https://brave.com/ja/learn/best-search-api-2026/), but they are vendor claims.

### 2.2 Terms on storing and showing results (what was found)
- Brave (https://api-dashboard.search.brave.com/documentation/resources/terms-of-service, read 2026-11-21): no storing, caching or building a database of Search Results beyond transient storage needed to run the application; no AI model training, evaluation or benchmarking with results; no redistribution; attribution optional ("POWERED BY BRAVE" wording if used); end users must be bound by a written agreement with similar obligations. The pricing page says storage rights need a custom plan. This matters for a product that keeps chat history: whether a bot reply that quotes a snippet counts as "storing" is a question for Brave or a lawyer (unverified).
- Google Gemini grounding: see 1.2 (display with suggestions, limited storage, no click tracking).
- Anthropic and OpenAI: show citations as links (see 1.1). No separate storage clause was found on the pages read.
- Tavily, Exa, Serper, Firecrawl, Jina, Kagi, You.com, Bocha, Zhipu: terms of service not read. Unverified. Do not assume snippets may be stored.
- Serper, SerpApi and similar wrap Google SERPs; SerpApi sells a "Legal Shield" from the Production plan ($150 per month) covering up to $2 million (page statement), which hints that the scraping itself carries legal risk. Whether Serper offers similar cover: unverified.

---

## 3. Design questions: what the sources show

### 3.1 Provider-side tool vs one self-run tool
Findings:
- Provider tools exist for OpenAI, Anthropic, Gemini, xAI, DeepSeek; each differs in request shape and response blocks (1.1). Support depends on the model (OpenAI: Responses API reasoning models or `gpt-5-search-api` only; Anthropic: listed models; DeepSeek: `deepseek-flash`; Google: listed Gemini models).
- Anthropic's server tools run inside the request and may return `pause_turn`; if a server tool and a client tool are called together the API returns `tool_use` and defers the server tool (server-tools page). A gateway that already runs its own tool loop would have to handle these provider-specific blocks per model.
- Provider tools bill search to whoever holds the API key at that provider and bill the search text as input tokens; the caller cannot cap the text size except through provider knobs (`max_uses`, `search_context_size`, `max_content_tokens`).
- OpenRouter shows the middle path: one plugin with selectable engines and one citation format, at published per-request prices.
- A self-run tool means the service defines the function schema once, executes the call, and returns text. This works for any model that supports function calling, which the service's loop already assumes. Caps, price, logging, safe-search and domain rules are then service decisions.

### 3.2 How products show sources to the user
- OpenAI: inline `url_citation` annotations with character ranges; requirement to show them as prominent clickable links; optional full `sources` list (page above).
- Anthropic: citations always on for search, with url, title, `cited_text`; must be shown when output is displayed directly (page above).
- Google: Search Suggestions HTML block shown with the answer, mandatory per terms (see 1.2).
- Perplexity: `search_results` array with title, url, date, snippet (docs page above).
- DeepSeek: `citations_delta` events that point to result URLs; blocks carry site name and icon (page above).
- A "searched N sites" line or citation chips are UI choices; the sources above only specify the data (url, title, text range), not the UI. Not found in primary sources: the exact UI of ChatGPT or Claude apps (not looked up).

### 3.3 Cost and abuse limits seen in the sources
- Per-reply caps: Anthropic `max_uses` (single-fact queries typically 1-3 searches, comparative research 10 or more, page statement), DeepSeek deep-thinking search up to about 20 tool calls (secondary: unverified), OpenAI search context cap 128k tokens.
- Per-day caps: Gemini default 1,500 grounded requests per day per project (paid tier).
- Safe search: Brave `safesearch` off/moderate/strict (moderate default). Not found for the others.
- Blocked domains: OpenAI up to 100, Tavily include 300 / exclude 150, xAI 5, Anthropic list with subpaths, Brave Goggles for reranking and filtering (pricing page).
- Free tiers are small (Tavily 1,000 credits per month, Exa $10 per month, Firecrawl 1,000 credits, Serper 2,500 queries one-off, SerpApi 250 per month, Google PSE 100 per day), so a shared hosted service will leave them quickly.

### 3.4 Prompt injection for fetched pages
- OpenAI agent-builder safety page (https://developers.openai.com/api/docs/guides/agent-builder-safety): do not let untrusted data directly drive agent behaviour; pass external input through user messages rather than developer messages; constrain outputs between steps with fixed schemas; require approval for tool actions; guardrails help but are not foolproof. The page says the measures lower the risk but do not eliminate it.
- Anthropic web fetch doc: warning about data exfiltration; restrict fetchable URLs to those already in the conversation, `allowed_domains`, `max_uses`; no fetching of URLs that look like credentials (see 1.2).
- OpenAI posts on link safety (https://openai.com/index/ai-agent-link-safety) and on prompt injection (https://openai.com/index/prompt-injections/) appeared in search results; I did not read them in full. One search summary says OpenAI calls prompt injection an open problem (December 2025 post): unverified without opening it.
- Firecrawl lists a "prompt injection check" as a paid scrape add-on (4 extra credits per page) on its pricing page.
- Pattern the sources agree on: page text is data, the tool should have no side effects (no further actions chained from page text), URLs the model may open should come from search results rather than from model-invented strings, and domain lists are optional extra controls.

### 3.5 Legal and terms notes
- robots.txt: Anthropic's fetch tool refuses URLs blocked by robots.txt (error doc). OpenAI documents `ChatGPT-User` as user-initiated fetches where robots.txt rules "may not apply", and `OAI-SearchBot` for search indexing (https://developers.openai.com/api/docs/bots). A self-run fetcher has to choose its own policy.
- Storing snippets: Brave and Google restrict it (see 2.2); other APIs unread.
- Copyright in quoting: Anthropic says that if you reprocess or combine outputs before display, display citations "based on consultation with your legal team". No source I read gives a safe quote length. Not verified; ask counsel.
- Chinese-model regulation: DeepSeek's doc says public-facing services must run their own content review, registration and AI labelling. The user's product is hosted for Chinese, Japanese and English users; whether this applies is a legal question (unverified).

---

## 4. Candidates for "one self-run tool"

Costs below use the listed price at the stated plan. "Cost per 1,000 searches at low volume" is the pay-as-you-go or entry price. Quality claims are unverified for zh/ja unless a source is named.

| Candidate | Cost per 1,000 searches (low volume) | Page fetch support | Latency (published) | zh / ja / en quality | Terms restrictions found |
|---|---|---|---|---|---|
| Brave Search | $5 (https://brave.com/search/api/) | LLM Context returns page chunks; no standalone fetch | Third-party benchmark says LLM Context median 0.95 s (secondary, via Parallel article, not opened: unverified) | zh/ja: unverified; parameters `country` / `search_lang` exist | No storing/caching beyond transient; no AI training use; optional attribution; storage needs custom plan |
| Tavily | $5-$8 (1 credit per basic search; $0.005-$0.0075 per plan credit, $0.008 pay-as-you-go) | Yes (Extract at 5 URLs per credit) | not published on pages read | `language` / `country` parameters; zh/ja quality unverified | not read |
| Exa | $4 (lite/instant) to $7 (auto) | Yes ($1 per 1,000 pages for contents) | not published on page read | Index described as English-leaning technical content in a secondary source (unverified); zh/ja unverified | not read |
| Serper | about $1 (secondary: unverified); 2,500 free queries (primary) | No | not published | Google results so coverage should follow Google (inference) | not read; Google SERP scraping risk (see SerpApi Legal Shield note) |
| SerpApi | $25 at 1,000/month plan, $15 at 5,000/month ($75), $10 at 15,000/month ($150) | No | not published | Google SERP | Legal Shield only from $150 plan |
| Firecrawl | about $2 on Standard ($99 for 100,000 credits, search 2 credits), about $7.6 on Hobby ($19 for 5,000 credits); free 500 searches | Yes (search with `scrapeOptions`, scrape at 1 credit) | not published | `location` only; zh/ja unverified | not read; scrape results include whatever the page says |
| Jina s.jina.ai + r.jina.ai | Not computable: search is a fixed charge starting at 10,000 tokens, token price not on page | Yes (r.jina.ai; free 20 RPM without key) | about 2.5 s search, about 7.9 s reader (page) | Original-language text returned; zh/ja ranking unverified | not read |
| Kagi | $12 | Yes (Extract $4 per 1,000) | not published | not read | not read |
| You.com | $5 | Yes (Extract $0.90 per 1,000 URLs) | 1-10 s per URL (extract) | not stated | not read |
| Perplexity Search API | $5 (Standard), $1 (Fast); no token charge | `fetch_url` is in the Agent API ($0.0005 per call); Context API $1 per 1,000 URLs | not published on page | not stated | not read |
| Zhipu search_std | 0.01 yuan per call (10 yuan per 1,000) | no | not published | built for Chinese; ja/en not mentioned | not read |
| Google PSE | $5 beyond 100 free per day | No | n/a | n/a | Closed to new customers |
| Bing API | n/a | n/a | n/a | n/a | Retired 2025-08-11 |

Reading of the table:
- On price the field is narrow: $4-$8 per 1,000 for most general-purpose APIs, one cheaper (Serper, unverified), Firecrawl varies a lot by plan.
- The ones with fetch included in the same vendor and bill: Tavily, Exa, Firecrawl, Jina, Kagi, You.com.
- The only candidate with an explicit storage-rights clause found is Brave (restricted).

---

## 5. What this suggests for Agent Family

(Opinion starts here; sections 1-4 are findings.)

### 5.1 Candidate designs

Assumptions used for cost: a "looked-up reply" runs 1.5 searches on average and in a third of cases one page read. Search text added to the prompt is about 1.5k tokens per search (5 results of snippets) and about 2.5k tokens per page read (Anthropic gives about 2,500 tokens for a 10 kB page). Token price depends on the chosen model; I use DeepSeek flash cache-miss input ($0.15 per 1M) only as a low reference and leave other models as "plus tokens". Prices are the list prices above; no discounts.

**Design A: one self-run `web_search` tool (plus optional `read_page`), single vendor.**
- The service defines one function schema for all models. It calls one search API (candidates: Brave at $5, Tavily at $5-8 with Extract included, Exa at $4-7 with contents) and returns trimmed results (title, url, snippet, date) to the model. Optional `read_page` calls the same vendor's extract or a cleaner like r.jina.ai, with a per-reply cap and size cap.
- Pros: works for every model on the gateway, one bill and one behaviour, per-reply and per-day caps are service-controlled, one citation format to render, no model-specific blocks, easy to swap vendor.
- Cons: the service owns the safety layer for page text (injection, size limits), snippet storage terms vary by vendor (Brave restricts), CJK quality unverified so a test is needed first, the model has to be good at deciding when to search.
- Rough cost per looked-up reply: search fee 1.5 x $0.005 = $0.0075 (Brave/Tavily low-end), $0.006-$0.0105 (Exa), plus page read about 0.33 x $0.001-$0.003 (Exa contents $0.001, Tavily extract $0.0016 at one credit per 5 URLs and $0.008 per credit); tokens: 1.5 x 1.5k + 0.33 x 2.5k = about 3.1k extra input tokens, about $0.0005 on deepseek-flash cache-miss. Total about $0.008-$0.012 plus tokens on other models.

**Design B: provider-side search where the provider offers it, self-run tool elsewhere.**
- Use OpenAI `web_search`, Anthropic `web_search`, Gemini grounding, xAI web search, DeepSeek `deepseek_web_search` when the chosen model has one; fall back to Design A for others.
- Pros: best fit to each model, citations are built in, some providers do dynamic filtering of results (Anthropic `web_search_20260209`) that cuts token use, no search vendor to manage for those models.
- Cons: four or five different request/response shapes and loop behaviours to handle (including `pause_turn` and deferred server tools on Anthropic), different caps and prices per model, Google needs Search Suggestions shown and forbids caching and click tracking, OpenAI's tool only through Responses (or one search model on Chat Completions), the service's cost hold must read each provider's usage field, behaviour differs from model to model so users see inconsistent results, still need Design A for fallback so the work is the sum of both.
- Rough cost per looked-up reply: OpenAI or Anthropic 1.5 x $0.010 = $0.015 plus tokens; Gemini 1.5 x $0.014 = $0.021 after the 5,000 free per month; xAI 1.5 x $0.005 = $0.0075; DeepSeek tokens only since 2026-11-18. Plus tokens in all cases, and OpenAI states fixed 8,000-token blocks for its two small models (8k x $0.15 per 1M = $0.0012 if priced like deepseek, not applicable to OpenAI's own rates which I did not read).

**Design C: gateway-level plugin through an aggregator (OpenRouter-style `:online` or equivalent).**
- Route web access through the aggregator the site already uses for some models, picking an engine per request (Exa, Parallel, Firecrawl, Perplexity or native).
- Pros: least code, one citation format (OpenAI `url_citation`), engine selectable, prices published (Exa $0.007, Parallel $0.001-$0.005, Perplexity $0.005), per-request `max_results`.
- Cons: only covers models routed through that aggregator, so DeepSeek direct and any direct provider endpoint are not covered; search text goes in as prompt text that the service does not control (no per-call cost hold between search and answer); not a tool-loop tool, so the model cannot choose whether to search per step; vendor terms stack on top of the aggregator's.
- Rough cost per looked-up reply: 1 request (the plugin runs once per request) at $0.001-$0.007 plus the result tokens as input; the model cannot decide how often to search, so every message routed that way pays, unless the service decides when to turn it on.

### 5.2 My recommendation (opinion)
- Design A looks like the best fit for "no heavy infrastructure, one bill, caps in our hands, works for every model". Start with one vendor and a small zh/ja/en test before locking in. Add provider-side tools later only for models where users clearly want them.
- If the first test puts CJK quality on one side, Zhipu (0.01 yuan per call) or Bocha could be a second engine for Chinese queries, but their terms, languages and prices need reading first.
- Keep the page read as a separate tool with its own small cap, because it is the larger token and injection risk and could be left out of the first batch.

### 5.3 Open questions for the product owner (max five)
1. Should the Agent's owner pay for searches in points per search, or is a lookup folded into the normal reply price?
2. Is a page-read tool needed in the first batch, or is search with snippets enough?
3. Which languages matter most for lookups on day one, so the CJK test can be built from real question types?
4. May the group see search sources in the chat history permanently, or should sources disappear with the reply (this decides whether a search vendor's storage clause matters)?
5. What is the acceptable daily search budget per Agent or per owner before the Agent says it cannot look things up?

---

## Not verified / gaps (plain list)
- Serper pricing and rate limit (own pages unreachable; only secondary sources).
- Perplexity Sonar request fees and Sonar deprecation details beyond the one docs page that states Sonar Chat Completions support ending 2026-09-27.
- Bing replacement price (secondary sources give $35 and $14).
- Terms of service for Tavily, Exa, Serper, Firecrawl, Jina, Kagi, You.com, Bocha, Zhipu.
- Bocha pricing and free tier; Zhipu free quota and concurrency.
- Brave LLM Context pricing; valid `search_lang` values for Chinese and Japanese.
- Any measured zh/ja quality for any search API.
- DeepSeek search rate limits and the list of models supporting it (only `deepseek-flash` is named by the primary page).
- OpenAI search tool rate limits per reply; whether Anthropic or OpenAI impose a numeric per-organization search rate limit.
- UI behaviour of ChatGPT, Claude, Perplexity and Gemini apps for showing sources (only the API data was read).
- Jina's per-token price and whether Jina's terms changed ownership recently (not checked).

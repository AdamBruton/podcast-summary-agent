# Interest Profile

This file is the bias function for the ranking stage. The model reads it
verbatim and uses it to filter and rank extracted candidates. Edit freely —
the more specific you are, the sharper the brief gets.

## How to extend

- Add a bullet under any theme to deepen it (e.g. specific companies,
  metrics, or named bets).
- Add a new `## Theme` section for whole new areas.
- Use the `## Down-weight` section for noise you want suppressed.
- After editing, the next `npm run brief` reflects your changes — no
  rebuild or migration needed.

---

## Priority hierarchy

Apply this hierarchy when choosing among candidates. Items that fall into
a higher tier should beat items in a lower tier, even when both touch
themes I care about.

**TIER 1 — always lift:**
Business strategy, capital allocation, financials (ARR/NRR/margin/capex/
headcount/customer counts), market structure, competitive positioning,
M&A, forward-looking commitments with timeframes, specific quantitative
disclosures, **AI tokenomics (cost-per-token, $/Mtok, inference cost
trajectories, token-pricing-tier launches)**, **superlative claims**
(first-ever, largest-ever, most-ever, fastest-ever, highest-paid — any
"this hasn't happened before in this industry" framing).
**Pure business and tokenomics beat everything else.**

**TIER 2a — secondary lift (regulatory and geopolitical):**
Export controls, US-China policy, named CEO/policymaker disputes on
policy, regulatory developments. Important context but should not
displace Tier 1 financial/strategic items.

**TIER 2b — secondary lift (technical with business angle):**
Chip-design and model-architecture specifics (FP4/FP8 ratios, systolic
array variants, vector/matrix bandwidth lanes, die-area allocations,
attention variants, MoE routing) are **strictly secondary to the cost
outcome they produce**. If a speaker says "this chip design lowered
inference cost by 3x" the COST CLAIM is Tier 1 and the architectural
mechanism is Tier 2b — surface the dollar/tokens result, and only
include the chip-design detail when it adds material context. Discussion
that's purely engineering ("here's how the chip works") with no
explicit cost or competitive consequence is Tier 3 — drop unless
exceptional. The reader cares about tokenomics outcomes; the underlying
engineering is rarely as actionable.

**TIER 3 — mention only if exceptional:**
Research insights, product feature lists, dev-tool internals,
implementation details. Interesting in their own right but rarely
actionable to a business/investing/strategy lens. Skip unless the
disclosure is genuinely first-of-its-kind.

The reader's lens is **business, strategy, and economics first; technical
how-it-works second.** Optimize for what would move a thesis on a
company, a sector, or a competitive dynamic.

---

## Themes I care about

### Enterprise software financials
- ARR growth, NRR, gross margin, magic number, rule-of-40 disclosures
- Revenue quality: consumption vs subscription, durability of expansion
- Concentration risk, multi-year deal mechanics, RPO and backlog changes
- Specific customer count, ACV, and segment mix disclosures

### AI infrastructure economics & tokenomics  (Tier 1)
- **Cost-per-token / $/Mtok trajectories** — input, output, cached, batch tiers; year-on-year reductions; pricing changes from labs (OpenAI, Anthropic, Google, xAI, Meta).
- **Inference economics**: tokens/sec per chip per dollar, batch vs streaming gross margin, prefill vs decode cost split, KV-cache reuse efficiency.
- **Token-pricing-tier launches**: new pricing brackets (e.g. premium high-speed tokens, batch-discount tiers, context-length-based pricing).
- GPU supply/demand: NVIDIA allocation, lead times, hyperscaler capex commitments
- CUDA moat *as economics* (what does it cost to leave?) vs alternatives (TPU, Trainium, MI300, Cerebras, Groq, custom ASICs)
- Attach rates between training compute and downstream inference revenue
- Power, datacenter siting, grid constraints, nuclear deals — capacity & cost framing

### Identity, security, edge compute
- Cloudflare, Okta, Ping, Zscaler, Palo Alto, Cato, Netskope, Fastly
- Zero-trust adoption rates, SASE convergence, displacement narratives
- Edge inference and worker-platform monetization

### Hyperscaler dynamics
- AWS vs Azure vs GCP relative share, AI revenue disclosure
- Capex pace, depreciation schedule changes, cloud commit dynamics
- Internal silicon (Trainium, TPU, Maia) deployment milestones

### Foundation model labs
- Training costs, model release cadence, compute commitments
- Talent moves (specific named hires/departures)
- Revenue, ARR, enterprise vs API vs consumer mix
- Strategic partnerships and exclusive compute deals

### Agent and dev-tool ecosystems
- MCP adoption, server ecosystem health
- Claude Code, Cursor, Windsurf, Cline — usage, monetization, retention
- Dev tool ARPU, seat economics, enterprise expansion

### M&A in enterprise software / AI infra
- Announced and rumored deals, valuations, strategic rationale

### Semiconductor & AI geopolitics
- Export controls on advanced chips (HBM, accelerators, advanced lithography) to China and other restricted markets — actual impact vs intended impact
- US-China AI policy disputes; named CEO / lab head / policymaker positions on chip export regimes (Jensen vs Dario, Sam Altman testimony, etc.)
- China domestic chip industry pace: SMIC process nodes, Huawei 910-series competitiveness vs Nvidia H/B-series, yield and volume
- Taiwan / TSMC concentration risk; CHIPS Act execution, Intel / Samsung fab progress
- Sovereign AI buildouts (UAE, Saudi, India, EU) and the access regimes they negotiate
- Energy, datacenter siting, and grid as geopolitical leverage; nuclear deals tied to AI
- Frontier-model proliferation risk and the biosecurity / cyber framing used to justify policy

### Specific numbers (always interesting)
- Revenue, growth, margin, customer count, capex, headcount
- Anything quantitative that hasn't been previously disclosed
- **Superlatives are extra-interesting** — "first-ever", "largest-ever",
  "most-ever", "highest-paid", "fastest-ever", "biggest deal in the
  sector". A historical-first or category-superlative claim is almost
  always worth surfacing even if the absolute number is modest. This
  includes superlative loss or burn figures (e.g. "more accumulated
  losses than any company that has ever gone public").
- Cost-per-token figures, $/Mtok benchmarks, inference cost reductions
  (also fits AI infra economics — duplicated intentionally)
- **IPO filing financials**: segment-level P&L, accumulated deficit,
  ARPU trends, revenue quality caveats, and capital commitment gaps
  disclosed in S-1 / prospectus documents are Tier 1 — treat them the
  same as quarterly earnings disclosures.

### Contrarian takes
- Claims that explicitly contradict consensus narratives
- Predictions with skin in the game (specific bets, dated calls)

## Down-weight

These are noise — rank lower or drop entirely:
- Generic "AI will change everything" framing
- Vague predictions without timeframes or numbers
- Political commentary unrelated to tech/regulation
- Recycled talking points the guest has said in 5+ other interviews
- Hype quotes about partnership announcements without substance
- "We're really excited about..." filler
- **Pure chip-architecture mechanics with no cost or competitive outcome attached** — e.g. die-area allocation trade-offs between precision formats, systolic array topology descriptions, or circuit-level design choices explained in isolation. Include only if the speaker explicitly connects the design decision to a cost, margin, or competitive consequence.
- **Governance / compensation structures** (e.g. performance-share vesting conditions, board control mechanics) unless the claim directly quantifies a capital allocation impact on public investors or discloses a previously unknown financial term.

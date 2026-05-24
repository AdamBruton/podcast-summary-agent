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
"this hasn't happened before in this industry" framing),
**cybersecurity industry dynamics** (vendor consolidation, breach
disclosures, AI-driven offense/defense shifts, security M&A, CISO
budget signals, attack-surface or vulnerability counts), and **SaaS
competitive dynamics** (AI-native displacement of incumbents, seat
compression from AI agents, vertical SaaS land-grab, PLG vs sales-led
shifts, usage-based vs subscription pricing transitions).
**Cybersecurity and SaaS are Tier 1 domains** — promote a candidate
to Tier 1 just for being credibly in either domain, even when the
category alone (e.g. a product detail) would normally sit lower.
**Pure business, tokenomics, cybersecurity, and SaaS beat everything else.**

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

### Enterprise software financials & SaaS competitive dynamics  (Tier 1)
- ARR growth, NRR, gross margin, magic number, rule-of-40 disclosures
- Revenue quality: consumption vs subscription, durability of expansion
- Concentration risk, multi-year deal mechanics, RPO and backlog changes
- Specific customer count, ACV, and segment mix disclosures
- **AI-native displacement of incumbent SaaS**: named cases where AI-native
  products are eating into installed bases (Cursor vs Copilot, Glean vs
  legacy enterprise search, AI agents vs Salesforce/ServiceNow workflows,
  Notion AI vs Confluence). Specific lost-deal disclosures or customer
  migrations.
- **Seat compression from AI**: claims that an AI agent reduces the seat
  count a customer needs, or that vendors are repricing per-outcome
  instead of per-seat. Quantified impact.
- **Vertical SaaS land-grab**: AI-first vertical SaaS entrants (legal,
  medical, accounting, claims, construction) with named ARR or customer
  counts that suggest a winner emerging.
- **PLG and usage-based pricing shifts**: companies moving from subscription
  to usage-metered, time-to-paid metrics, or self-serve revenue mix.
- **Multi-product expansion / platform play**: a SaaS vendor's second/third
  product unit economics, attach rate, or cross-sell motion.

### AI infrastructure economics & tokenomics  (Tier 1)
- **Cost-per-token / $/Mtok trajectories** — input, output, cached, batch tiers; year-on-year reductions; pricing changes from labs (OpenAI, Anthropic, Google, xAI, Meta).
- **Inference economics**: tokens/sec per chip per dollar, batch vs streaming gross margin, prefill vs decode cost split, KV-cache reuse efficiency.
- **Token-pricing-tier launches**: new pricing brackets (e.g. premium high-speed tokens, batch-discount tiers, context-length-based pricing).
- **Jevons paradox dynamics**: price reductions triggering outsized volume increases — quantified examples of consumption elasticity at AI labs are Tier 1.
- GPU supply/demand: NVIDIA allocation, lead times, hyperscaler capex commitments
- CUDA moat *as economics* (what does it cost to leave?) vs alternatives (TPU, Trainium, MI300, Cerebras, Groq, custom ASICs)
- Attach rates between training compute and downstream inference revenue
- Power, datacenter siting, grid constraints, nuclear deals — capacity & cost framing

### Cybersecurity, identity, edge compute  (Tier 1)
- Cloudflare, Okta, Ping, Zscaler, Palo Alto, Cato, Netskope, Fastly,
  CrowdStrike, SentinelOne, Wiz, Snyk, 1Password, Tailscale
- **Breach / incident disclosures**: customer-count or cost figures from
  named breaches, ransomware payout data, attack-pattern shifts, dwell-
  time changes, lateral-movement claims.
- **AI on offense**: autonomous penetration testing, model-found
  vulnerabilities (e.g. Mythos / Big Sleep type capability claims),
  AI-scaled phishing, deepfake-driven fraud cases. Quantified attack
  scale or efficacy.
- **AI on defense**: SOC automation, alert-triage reduction percentages,
  AI-augmented analyst productivity, MDR/XDR pricing changes, AI-driven
  EDR feature claims.
- **Vulnerability disclosures**: CVE counts found by AI vs prior
  baselines, named software with novel attack surface, supply-chain
  compromises.
- **Cybersecurity M&A and vendor consolidation**: platform plays
  (CrowdStrike/Wiz-class acquisitions), security-stack convergence
  (SASE, CNAPP, SSPM merging into single vendors), CIO budget
  consolidation toward fewer security vendors.
- **CISO budget signals**: security spend as % of IT, year-on-year
  budget growth, line-item shifts (e.g. moving from prevention to
  detection-and-response).
- **Cyber insurance dynamics**: premium changes, exclusions, coverage
  shifts that reflect underlying risk trends.
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
- **Multi-cloud and multi-chip positioning**: which labs run on which clouds/chips, exclusivity or fungibility claims — competitive differentiation at the infrastructure layer.
- **Internal AI adoption metrics as PMF signal**: quantified self-use disclosures (e.g. % of internal code written by the model, number of internal skills/automations deployed, headcount-equivalent productivity claims) — these are Tier 1 proxies for product-market fit and enterprise readiness.
- **Per-vertical adoption curves**: when a lab names a specific product or vertical (e.g. coding) as an inflection-point analog for predicting adoption in other verticals, surface it — it frames TAM expansion thesis.

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
  same as quarterly earnings disclosures. This includes segment-level
  operating profit/loss breakdowns (e.g. connectivity vs. space vs. AI
  divisions) and ARPU trajectory disclosures.
- **Competitive revenue comparisons**: when a speaker directly quantifies
  one company's revenue or market share relative to a named competitor
  (e.g. lab A's quarterly revenue vs. lab B's annual AI segment revenue),
  surface it — it is Tier 1 competitive intel.

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
- **Pure chip-architecture mechanics with no cost or competitive outcome attached** — e.g. die-area allocation trade-offs between precision formats, systolic array topology descriptions (including "splittable" or other novel array variants), or circuit-level design choices explained in isolation. Include only if the speaker explicitly connects the design decision to a cost, margin, or competitive consequence.
- **Governance / compensation structures** (e.g. performance-share vesting conditions, board control mechanics) unless the claim directly quantifies a capital allocation impact on public investors or discloses a previously unknown financial term. Vesting milestones tied to speculative targets (Mars colony, multi-trillion market caps) are drop unless the immediate shareholder-rights mechanics (voting, pledging, dividends) are quantified.
- **CEO management-style commentary**: how a CEO personally communicates internally, their self-described management philosophy, or statements about their own leadership fit for a role — drop unless the disclosure names a specific near-term org change (e.g. a named hire for a specific role with a timeline).
- **Vague foundation or philanthropy size claims** without a disclosed capital amount, grant recipient, or investment mandate that has direct business consequence.
- **Infrastructure commitment disclosures without cost figures**: land, power, or lease agreements stated in years or gigawatts alone, without an associated dollar commitment or per-unit cost implication, are Tier 3.

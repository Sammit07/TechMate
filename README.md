# 🛠️ TechMate: AI IT service desk on a knowledge graph

TechMate is an AI assistant and workspace for an L1 IT service desk. Employees describe a problem in plain language and get step-by-step fixes from the company knowledge base. If self-help isn't enough, TechMate raises a ticket, classifies it and routes it to the right support group. Service-desk staff get a live dashboard, a ticket-volume forecast, and a network graph of how each incident was raised, routed and resolved. The graph also shows what affected each incident, such as maintenance, power work, outages, Windows updates or holidays.

🌐 **Live demo:** _to be added after deployment to Vercel_

---

## 📑 Contents

- 🎯 [Objective](#-objective)
- 💡 [Motivation](#-motivation)
- ⚙️ [How it works](#-how-it-works)
- ✨ [Features](#-features)
- 📊 [Technical specifications](#-technical-specifications)
- 🗂️ [Project structure](#-project-structure)
- 🚀 [Setup (local)](#-setup-local)
- 🔧 [Configuration](#-configuration)
- 📥 [Loading data](#-loading-data)

---

## 🎯 Objective

Reduce the load on an L1 service desk and speed up resolution by:

1. **Resolving common issues without a ticket**: VPN, passwords, account lockouts, Wi-Fi and Ethernet, laptops, OS updates, Outlook, Teams, printers and more. Answers come from the company knowledge base, with citations.
2. **Raising better tickets when a person is needed**: the right category, ITIL priority (impact × urgency) and support group, filled in automatically.
3. **Helping agents resolve faster**: similar resolved tickets, known cause → fix paths, and the relevant KB articles for every ticket.
4. **Showing what's going on**: a live dashboard, a forecast of how many tickets to expect, and which incidents were caused by planned maintenance, outages, updates or holidays.

## 💡 Motivation

Most L1 tickets repeat the same few dozen problems. The answers already exist in knowledge-base articles and in how past tickets were resolved, but they're hard to find in the moment. Classic keyword search misses paraphrases ("VPN says certificate expired" vs "GlobalProtect auth failure"). Plain vector search misses exact error codes and the relationships between symptoms, causes and fixes.

TechMate combines both with a knowledge graph (**GraphRAG with hybrid retrieval**) to answer reliably and cite its sources. Because tickets, people, devices, support groups, knowledge and operational events all live in one graph, the same data also explains *why* an incident happened and *how* it moved through the desk.

## ⚙️ How it works

TechMate has three parts:

- **The web app** (Next.js) is what employees and service-desk agents use. It has eight pages: Assistant, Tickets, Knowledge base, Dashboard, Forecast, Network graph, Events and Data upload. There's also a sign-in page and a workspace switcher. It talks only to TechMate's own API, on the same site.
- **The API** (FastAPI, Python) does the work: understanding questions and answering them, classifying and routing tickets, analytics and forecasting, linking events to incidents, building graph views, handling uploads and workspaces, and checking sign-in. Answers are streamed to the browser as they're written.
- **The knowledge graph** (FalkorDB) holds all the data. Each workspace has its own graph, and a small extra graph keeps the list of workspaces. The language models come from Nebius Token Factory:
  - **Nemotron Super** is the fast model, used for understanding and extraction;
  - **Nemotron Ultra** writes the answers;
  - **Qwen3** turns text into embeddings for search.

💬 **A chat turn, step by step**

1. **Understand.** The fast model classifies the message: troubleshoot, create a ticket, ask about an existing ticket, or a general question. It also rewrites the message into a standalone search query using the conversation so far.
2. **Retrieve (hybrid GraphRAG).** Three rankings of knowledge-base passages are fused with weighted reciprocal-rank fusion:
   - **vector**: cosine similarity on Qwen3 embeddings;
   - **keyword**: full-text search, which catches exact error codes;
   - **graph**: passages that mention the entities in the question (products, error codes, symptoms).
   The graph also supplies *cause → fix* paths and the most similar *resolved* tickets.
3. **Check for known events.** If planned maintenance, power work, a network change or an outage is happening now and matches the problem, the assistant says so first.
4. **Answer.** The reasoning model streams an answer grounded only in those sources, with citations like `[KB0010017]`.
5. **Escalate.** If the user asks for help or the steps fail, the classifier drafts a ticket (subcategory, priority, support group) for the user to confirm.

🕸️ **What the knowledge graph connects** (in each workspace)

- **Who and where:** each ticket links to the person who raised it, their office location and their device.
- **Classification and routing:** each ticket links to its subcategory and category. Each subcategory has a default support group. Each ticket also links to the support group and agent who handled it.
- **Knowledge:** knowledge-base articles are split into passages. Each passage stores its embedding and links to the *entities* it mentions: products, components, error codes, symptoms, causes and fixes.
- **Cause and fix:** entities link to each other, for example "symptom *caused by* cause" and "cause *fixed by* fix". This gives the assistant known cause → fix paths.
- **Ticket to knowledge:** tickets link to the entities they mention and to the article that resolved them. That's how similar resolved tickets are found.
- **Events:** maintenance, power work, outages, holidays and Patch Tuesdays link to the locations and ticket areas they affect, and to each incident they affected, with the reason (for example "opened during it").

## ✨ Features

| Area | What it does |
|---|---|
| 🤖 **Assistant** | Streaming chat with citations. Answers questions about existing tickets ("what is INC2005973 about / how do we resolve it?") using the ticket, the knowledge base and similar resolved tickets. Drafts and creates tickets. Warns about known maintenance or outages that match the problem. |
| 🎫 **Tickets** | Searchable, filterable queue. Each ticket shows linked events, suggested fixes (GraphRAG) and similar resolved tickets, and has an agent update panel: state, priority, reassignment, work notes, resolution. |
| 🧭 **Classification & routing** | ITIL impact × urgency → priority; subcategory → owning support group, taken from the graph. Flags a possible major incident when several similar tickets arrive within 2 hours. |
| 📚 **Knowledge base** | 106 articles (PDF), each with the entities extracted for the graph. Searchable by meaning and keywords. Upload your own PDF, TXT or Markdown documents; they're indexed in seconds and cited straight away. |
| 📈 **Dashboard** | Live (30 s refresh): open tickets and SLA status, created vs resolved, categories, support groups, weekday × hour heatmap, reassignment rate, past-SLA list, spike detection, and events now and in the next 14 days. |
| 🔮 **Forecast** | Expected tickets per day, category and support group for the next 14 or 28 days, with an 80% range. Uses Holt-Winters (weekly seasonality, damped trend) plus learned holiday and Patch Tuesday effects. The backtest on 28 held-out days is shown on the page. |
| 🗓️ **Events** | Upload or paste a maintenance, electrical/power work, network change or outage notice. The AI reads the events (time window, locations, likely affected ticket areas) for you to check. Saved events are linked to the incidents they affected, shown on tickets, in the assistant and on the dashboard. Holidays, Patch Tuesdays and past outages are included. |
| 🕸️ **Network graph** | For any ticket: inputs (caller, location, channel, device, events) → ticket → classification → routing (triage → reassignments → group → agent) → outcome (resolution, KB article, similar tickets). For any event: where and what it hit → linked incidents → groups → outcome. Interactive, in light and dark mode. |
| 📤 **Data upload** | Import tickets from a ServiceNow incident export (CSV), with a check-first preview. Upload knowledge documents and notices. Every upload can be undone. |
| 🏢 **Workspaces** | Separate service desks, each with its own tickets, knowledge base, events and uploads (one graph each). Start blank or with the standard knowledge base. |
| 🔐 **Sign-in** | The whole app is behind a password, with a signed, HttpOnly session cookie. |

## 📊 Technical specifications

| | |
|---|---|
| 🖥️ **Frontend** | Next.js 16.4 (App Router, Turbopack, Cache Components, Partial Prerendering), React 19.3, TypeScript, Tailwind CSS v4, shadcn/ui (Radix), Recharts 3, next-themes |
| 🐍 **Backend** | Python 3.12, FastAPI, Pydantic v2, Server-Sent Events for streaming, pure-Python forecasting (no numpy) |
| 🗄️ **Database** | FalkorDB (Redis-protocol graph database): Cypher, range, full-text and vector (HNSW, cosine) indexes; one graph per workspace |
| 🧠 **Models** (Nebius Token Factory, OpenAI-compatible) | `nvidia/nemotron-3-super-120b-a12b`: intent, classification, entity and notice extraction<br>`nvidia/Nemotron-3-Ultra-550b-a55b`: answers<br>`Qwen/Qwen3-Embedding-8B` at 1024 dimensions: embeddings |
| 🧪 **Demo data** | 5,994 synthetic L1 tickets (Sep 2025 – Oct 2026) in ServiceNow's export format (29 columns), with weekly rhythm, Patch Tuesday, password-expiry waves, onboarding months, monsoon VPN issues, holidays, growth and 3 outages. 106 synthetic KB articles (PDF). 34 subcategories, 9 categories, 7 support groups. |
| 🎯 **Retrieval quality** | Evaluated on 150 tickets: correct article in the top 5 for 96.7% (hybrid) and 97.3% (vector only); relevant source ranked first 96.0% |
| 📉 **Forecast accuracy** | Backtest on 28 days: daily WAPE 25.8% vs 35.2% for "same day last week" (27% better); weekly-total error 10.5% |
| ⚡ **Performance** | Chat answer about 6–9 s (first words after about 4 s, streamed). Dashboard about 2 s cold, cached for 30 s. Document upload about 6 s per short article. |
| 💾 **Footprint** | Demo graph about 35 MB. A workspace with the standard knowledge base adds about 25 MB. |
| ☁️ **Hosting** | Vercel (Next.js frontend + Python Services backend), FalkorDB Cloud, Nebius Token Factory |

## 🗂️ Project structure

```
backend/                 FastAPI app (deployed as Vercel Python functions)
  main.py                entry point
  app/api.py             routes, middleware, error handling
  app/auth.py            sign-in + workspace selection (ASGI middleware)
  app/retrieval.py       hybrid GraphRAG retrieval
  app/services/          assistant, classifier, tickets, analytics, forecast, events, graph views, workspaces, KB
  app/ingest/            CSV ticket import, document ingestion, upload history
  static/kb/             the standard knowledge base's PDFs (served behind sign-in)
frontend/                Next.js app
  src/app/(app)/         pages: assistant, tickets, kb, dashboard, forecast, graph, events, data
  src/app/login/         sign-in page
  src/components/        UI (assistant, tickets, dashboard, forecast, graph, events, data, workspace switcher)
  src/proxy.ts           redirects signed-out visitors to the sign-in page
scripts/                 data loading and retrieval evaluation
data/                    demo tickets (CSV), KB manifest, entity-extraction cache (uploads are git-ignored)
```

## 🚀 Setup (local)

✅ **Prerequisites:** Python 3.12, Node.js 20+, a FalkorDB instance (FalkorDB Cloud or Docker), and a Nebius Token Factory API key.

The commands below are for Windows PowerShell; on macOS or Linux use `source .venv/bin/activate` and `cp`.

```powershell
git clone https://github.com/Sammit07/TechMate.git techmate
cd techmate

# 1. Configuration
Copy-Item .env.example .env        # then fill in the keys (see Configuration)

# 2. Python environment (backend + data scripts)
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt -r scripts\requirements.txt

# 3. Frontend
cd frontend
npm install                        # if PowerShell resolves npm oddly, use npm.cmd
cd ..
```

📥 **Load the demo data** into the default workspace (about 5–10 minutes the first time; see [Loading data](#-loading-data)):

```powershell
python scripts\load_tickets.py
python scripts\load_kb.py
python scripts\load_events.py
```

▶️ **Run** in two terminals:

```powershell
# terminal 1: API on http://127.0.0.1:8000 (docs at /api/docs)
.venv\Scripts\python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000

# terminal 2: web app on http://127.0.0.1:3000 (proxies /api to the backend)
cd frontend
npm run dev
```

Open http://127.0.0.1:3000 and sign in with your `APP_PASSWORD`. If it's empty, sign-in is off.

## 🔧 Configuration

All settings come from environment variables: `.env` locally, Project Settings → Environment Variables on Vercel. Never commit `.env`.

| Variable | Purpose |
|---|---|
| `TOKEN_FACTORY_BASE_URL`, `TOKEN_FACTORY_API_KEY` | Nebius Token Factory endpoint and key |
| `MODEL_FAST`, `MODEL_REASONING`, `EMBED_MODEL`, `EMBED_DIMENSIONS` | Model ids (see Technical specifications); embeddings at 1024 dimensions |
| `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD`, `FALKORDB_SSL` | FalkorDB connection (`FALKORDB_SSL=true` on TLS-enabled plans) |
| `GRAPH_NAME` | Graph of the default (demo) workspace |
| `META_GRAPH`, `DEFAULT_WORKSPACE_NAME` | Workspace registry graph and the default workspace's display name |
| `APP_PASSWORD` | **Password for the whole app. Required in production.** Empty = no sign-in (local only) |
| `AUTH_SECRET`, `SESSION_DAYS` | Optional session-signing secret (default: derived from the password) and session length |
| `ADMIN_TOKEN` | Optional extra key for uploads, undo and deleting workspaces |
| `MAX_UPLOAD_MB` | Upload size limit (default 4; Vercel accepts request bodies up to 4.5 MB) |
| `APP_TIMEZONE` | Business time zone for timestamps, "today" and forecasts (default `Asia/Kolkata`) |
| `CORS_ORIGINS`, `RATE_LIMIT_CHAT_PER_MINUTE`, `RATE_LIMIT_WRITE_PER_MINUTE` | API origin allow-list and per-IP rate limits |

## 📥 Loading data

| Script | What it does |
|---|---|
| `scripts/load_tickets.py` | Loads the taxonomy and the demo tickets (`data/tickets/l1_tickets.csv`) into the default workspace, using the same importer as the upload page |
| `scripts/load_kb.py` | Chunks, embeds and entity-extracts the KB into the graph. Results are cached in `data/graph_cache/`; `--link-only` re-links tickets after a ticket reload |
| `scripts/load_events.py` | Creates holiday, Patch Tuesday and past-outage events and links them to tickets |
| `scripts/eval_retrieval.py` | Measures retrieval quality on held-out tickets |

You can also bring your own data through the app: go to **Data upload**, then upload a ServiceNow incident CSV, knowledge documents and notices. Create a new workspace first to keep it separate from the demo.

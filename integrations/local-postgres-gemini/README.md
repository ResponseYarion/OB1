# Local PostgreSQL + Gemini Setup

Run Open Brain without Supabase or OpenRouter.

This setup keeps the Open Brain shape that the repo expects, but replaces:

- Supabase with local PostgreSQL + pgvector
- OpenRouter with the Gemini API
- The hosted edge-function pattern with a small self-hosted Deno MCP server

## Recommended Local Database

Use **PostgreSQL + pgvector**.

Why this is the best fit for Open Brain:

- The repo already assumes PostgreSQL-style SQL, JSONB metadata, and vector search
- `pgvector` gives you cosine similarity in the same database as your metadata
- You avoid rewriting recipes that already expect `thoughts`, `metadata`, and vector search
- It is free, local, and easy to back up

I would **not** recommend SQLite as the primary database for this repo unless you want to rework more of the project. A single-file database is nice, but Open Brain is much closer to Postgres than SQLite in both schema shape and query style.

## What This Folder Gives You

- A local PostgreSQL + pgvector database via Docker Compose
- A Deno MCP server that talks directly to PostgreSQL
- Native Gemini embedding calls
- Gemini 2.5 Flash metadata extraction
- Automatic schema bootstrap on first start
- Deduplication with `content_fingerprint`

## Prerequisites

- Docker Desktop
- A Gemini API key from Google AI Studio
- An MCP client that can call an HTTP MCP endpoint

If your MCP client requires a public HTTPS URL instead of `http://localhost`, tunnel the local MCP port with something like Cloudflare Tunnel or Tailscale Funnel.

## Model Notes

This folder defaults to:

- `EMBEDDING_MODEL=gemini-embedding-2-preview`
- `CHAT_MODEL=gemini-2.5-flash`

That matches your requested setup.

One caveat: as of **April 15, 2026**, Google's official docs clearly document `gemini-embedding-001` for configurable output dimensionality and `gemini-2.5-flash` for structured JSON output. `gemini-embedding-2-preview` is documented for multimodal embeddings and can work here, but if you run into preview-model issues I would switch the embedding model to:

```env
EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_OUTPUT_DIMENSIONALITY=1536
```

That is the safest text-only fallback for this project.

Official docs:

- [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini model list](https://ai.google.dev/gemini-api/docs/models)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)

## Files

- `.env.example` - environment template
- `docker-compose.yml` - starts PostgreSQL and the MCP server
- `deno.json` - Deno dependencies
- `index.ts` - MCP server with PostgreSQL + Gemini integration
- `metadata.json` - contribution metadata

## Setup

### 1. Copy the environment file

PowerShell:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and set:

- `POSTGRES_PASSWORD`
- `MCP_ACCESS_KEY`
- `GEMINI_API_KEY`

You can keep the default models exactly as written if you want the requested Gemini setup.

### 2. Start the stack

From this folder:

```powershell
docker compose up --build
```

On first boot the MCP server:

- waits for PostgreSQL
- asks Gemini for one probe embedding to discover the vector length
- creates the `thoughts` table and indexes if they do not exist

### 3. Test the MCP endpoint

In another terminal:

```powershell
$headers = @{
  "x-brain-key" = "YOUR_MCP_ACCESS_KEY"
  "Content-Type" = "application/json"
}

$body = '{"jsonrpc":"2.0","method":"tools/list","id":1}'

Invoke-WebRequest -Uri "http://localhost:8000" -Method POST -Headers $headers -Body $body
```

You should see the four tools:

- `search_thoughts`
- `list_thoughts`
- `thought_stats`
- `capture_thought`

### 4. Connect your MCP client

If your client accepts a local HTTP MCP URL, point it at:

```text
http://localhost:8000?key=YOUR_MCP_ACCESS_KEY or
can also just add stdio config like this "open_brain_local": {
  "command": "npx",
  "args": [
    "mcp-remote",
    "http://localhost:8000?key=MCP_ACCESS_KEY" 
  ]
}
```

If your client only accepts a public HTTPS connector URL, expose the same local service through a tunnel and use that HTTPS URL instead.

## Data Shape

This setup keeps the familiar `thoughts` table fields:

- `id`
- `content`
- `embedding`
- `metadata`
- `content_fingerprint`
- `created_at`
- `updated_at`

That means most recipes and patterns in the repo will still make sense conceptually, even though you are no longer using Supabase.

## A Good Default Configuration

For your use case, I would personally run:

```env
EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_OUTPUT_DIMENSIONALITY=1536
CHAT_MODEL=gemini-2.5-flash
```

Why:

- `gemini-2.5-flash` is a good fit for lightweight metadata extraction
- `gemini-embedding-001` is the more clearly documented text embedding path
- `1536` dimensions stay close to the original Open Brain shape
- storage stays reasonable

If you want to stick strictly to your requested preview embedding model, leave the defaults alone and let the server detect the vector dimension automatically.

## Troubleshooting

**The server fails on startup with a vector dimension error**

- You likely created the table with one model and then switched embedding models later
- Delete the local Postgres volume and start fresh, or re-embed all data using one embedding model consistently

**The MCP endpoint works but search quality is poor**

- Keep one embedding model for both writes and queries
- Avoid mixing old vectors from different models

**Gemini metadata output is malformed**

- The server already falls back to a safe default object
- If this happens often, keep `CHAT_MODEL=gemini-2.5-flash` and avoid older preview chat models

**My client refuses `localhost`**

- Use a tunnel and point the client at the tunneled HTTPS URL

## Expected Outcome

After setup you will have:

- a free local database
- semantic search on your own machine
- Gemini-based embeddings and metadata extraction
- an MCP endpoint that exposes the same core Open Brain actions

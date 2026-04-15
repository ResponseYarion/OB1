import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { Pool } from "postgres";
import { z } from "zod";

const DB_HOST = Deno.env.get("DB_HOST") || "127.0.0.1";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "openbrain";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "gemini-embedding-2-preview";
const EMBEDDING_OUTPUT_DIMENSIONALITY = Deno.env.get("EMBEDDING_OUTPUT_DIMENSIONALITY");
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "gemini-2.5-flash";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";
const MCP_PORT = parseInt(Deno.env.get("MCP_PORT") || "8000", 10);

if (!DB_PASSWORD) throw new Error("Missing DB_PASSWORD");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
if (!MCP_ACCESS_KEY) throw new Error("Missing MCP_ACCESS_KEY");

const pool = new Pool(
  {
    hostname: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  },
  10,
  true
);

function normalizeEmbedding(values: number[]): number[] {
  const magnitude = Math.hypot(...values);
  if (!magnitude) return values;
  return values.map((value) => value / magnitude);
}

async function sha256Hex(input: string): Promise<string> {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extractGeminiText(data: unknown): string {
  const part = (data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  })?.candidates?.[0]?.content?.parts?.[0];
  return part?.text || "";
}

async function getEmbedding(text: string): Promise<number[]> {
  const body: Record<string, unknown> = {
    content: {
      parts: [{ text }],
    },
  };

  if (EMBEDDING_OUTPUT_DIMENSIONALITY) {
    body.output_dimensionality = parseInt(EMBEDDING_OUTPUT_DIMENSIONALITY, 10);
  }

  const response = await fetch(
    `${GEMINI_BASE}/models/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Gemini embedding failed: ${response.status} ${message}`);
  }

  const data = await response.json();
  const values =
    data?.embedding?.values ||
    data?.embeddings?.[0]?.values;

  if (!Array.isArray(values) || !values.length) {
    throw new Error("Gemini embedding response did not include vector values");
  }

  return normalizeEmbedding(values.map((value: unknown) => Number(value)));
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const prompt = `Extract metadata from the captured thought.

Return a JSON object with exactly these keys:
- people: array of strings
- action_items: array of strings
- dates_mentioned: array of strings in YYYY-MM-DD when explicit, otherwise []
- topics: array of 1 to 3 short topic tags
- type: one of observation, task, idea, reference, person_note

Rules:
- Only extract what is explicitly present.
- Do not infer extra facts.
- If nothing fits, use topics ["uncategorized"] and type "observation".

Thought:
${text}`;

  const response = await fetch(
    `${GEMINI_BASE}/models/${CHAT_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    }
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Gemini metadata extraction failed: ${response.status} ${message}`);
  }

  const data = await response.json();
  const textResponse = extractGeminiText(data);

  try {
    const parsed = JSON.parse(textResponse);
    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      dates_mentioned: Array.isArray(parsed.dates_mentioned) ? parsed.dates_mentioned : [],
      topics:
        Array.isArray(parsed.topics) && parsed.topics.length
          ? parsed.topics.slice(0, 3)
          : ["uncategorized"],
      type:
        typeof parsed.type === "string" && parsed.type
          ? parsed.type
          : "observation",
    };
  } catch {
    return {
      people: [],
      action_items: [],
      dates_mentioned: [],
      topics: ["uncategorized"],
      type: "observation",
    };
  }
}

async function getExistingVectorDimension(): Promise<number | null> {
  const client = await pool.connect();
  try {
    const result = await client.queryObject<{ data_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS data_type
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public'
         AND c.relname = 'thoughts'
         AND a.attname = 'embedding'
         AND NOT a.attisdropped`
    );

    const dataType = result.rows[0]?.data_type;
    const match = dataType?.match(/vector\((\d+)\)/);
    return match ? parseInt(match[1], 10) : null;
  } finally {
    client.release();
  }
}

async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.queryArray("CREATE EXTENSION IF NOT EXISTS vector");
    await client.queryArray("CREATE EXTENSION IF NOT EXISTS pgcrypto");

    const existsResult = await client.queryObject<{ exists: string | null }>(
      "SELECT to_regclass('public.thoughts') AS exists"
    );

    let vectorDimension = await getExistingVectorDimension();

    if (!vectorDimension) {
      const probeEmbedding = await getEmbedding("Open Brain schema bootstrap probe");
      vectorDimension = probeEmbedding.length;
    }

    if (!existsResult.rows[0]?.exists) {
      await client.queryArray(`
        CREATE TABLE thoughts (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          content TEXT NOT NULL,
          embedding vector(${vectorDimension}),
          metadata JSONB DEFAULT '{}'::jsonb,
          content_fingerprint TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);
    } else {
      await client.queryArray(
        "ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_fingerprint TEXT"
      );
      await client.queryArray(
        "ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()"
      );
    }

    await client.queryArray(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_content_fingerprint ON thoughts (content_fingerprint)"
    );
    await client.queryArray(
      "CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts (created_at DESC)"
    );
    await client.queryArray(
      "CREATE INDEX IF NOT EXISTS idx_thoughts_metadata ON thoughts USING GIN (metadata)"
    );
    await client.queryArray(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.queryArray("DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts");
    await client.queryArray(`
      CREATE TRIGGER thoughts_updated_at
      BEFORE UPDATE ON thoughts
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at()
    `);

    console.log(`Open Brain schema ready with vector dimension ${vectorDimension}`);
  } finally {
    client.release();
  }
}

const server = new McpServer({
  name: "open-brain-local-gemini",
  version: "1.0.0",
});

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description: "Search captured thoughts by meaning.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmbedding = await getEmbedding(query);
      const embeddingText = `[${qEmbedding.join(",")}]`;

      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          content: string;
          metadata: Record<string, unknown>;
          similarity: number;
          created_at: string;
        }>(
          `SELECT content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [embeddingText, threshold, limit]
        );

        if (!result.rows.length) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        const lines = result.rows.map((row, index) => {
          const metadata = row.metadata || {};
          const parts = [
            `--- Result ${index + 1} (${(row.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(row.created_at).toLocaleDateString()}`,
            `Type: ${metadata.type || "unknown"}`,
          ];

          if (Array.isArray(metadata.topics) && metadata.topics.length) {
            parts.push(`Topics: ${(metadata.topics as string[]).join(", ")}`);
          }
          if (Array.isArray(metadata.people) && metadata.people.length) {
            parts.push(`People: ${(metadata.people as string[]).join(", ")}`);
          }
          if (Array.isArray(metadata.action_items) && metadata.action_items.length) {
            parts.push(`Actions: ${(metadata.action_items as string[]).join("; ")}`);
          }

          parts.push("", row.content);
          return parts.join("\n");
        });

        return {
          content: [{ type: "text" as const, text: `Found ${result.rows.length} thought(s):\n\n${lines.join("\n\n")}` }],
        };
      } finally {
        client.release();
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description: "List recently captured thoughts with optional metadata filters.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
      days: z.number().optional(),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let index = 1;

      if (type) {
        conditions.push(`metadata->>'type' = $${index}`);
        params.push(type);
        index++;
      }
      if (topic) {
        conditions.push(`metadata->'topics' ? $${index}`);
        params.push(topic);
        index++;
      }
      if (person) {
        conditions.push(`metadata->'people' ? $${index}`);
        params.push(person);
        index++;
      }
      if (days) {
        conditions.push(`created_at >= NOW() - ($${index} * INTERVAL '1 day')`);
        params.push(days);
        index++;
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT content, metadata, created_at
           FROM thoughts
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${index}`,
          [...params, limit]
        );

        if (!result.rows.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        const lines = result.rows.map((row, idx) => {
          const metadata = row.metadata || {};
          const topics = Array.isArray(metadata.topics) ? (metadata.topics as string[]).join(", ") : "";
          return `${idx + 1}. [${new Date(row.created_at).toLocaleDateString()}] (${metadata.type || "unknown"}${topics ? " - " + topics : ""})\n   ${row.content}`;
        });

        return {
          content: [{ type: "text" as const, text: `${result.rows.length} recent thought(s):\n\n${lines.join("\n\n")}` }],
        };
      } finally {
        client.release();
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get counts, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const client = await pool.connect();
      try {
        const countResult = await client.queryObject<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM thoughts"
        );
        const dataResult = await client.queryObject<{
          metadata: Record<string, unknown>;
          created_at: string;
        }>("SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC");

        const count = countResult.rows[0]?.count || 0;
        const rows = dataResult.rows;
        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        for (const row of rows) {
          const metadata = row.metadata || {};
          if (typeof metadata.type === "string") {
            types[metadata.type] = (types[metadata.type] || 0) + 1;
          }
          if (Array.isArray(metadata.topics)) {
            for (const topic of metadata.topics) {
              topics[String(topic)] = (topics[String(topic)] || 0) + 1;
            }
          }
          if (Array.isArray(metadata.people)) {
            for (const person of metadata.people) {
              people[String(person)] = (people[String(person)] || 0) + 1;
            }
          }
        }

        const top = (counts: Record<string, number>) =>
          Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const output = [
          `Total thoughts: ${count}`,
          `Date range: ${
            rows.length
              ? `${new Date(rows[rows.length - 1].created_at).toLocaleDateString()} -> ${new Date(rows[0].created_at).toLocaleDateString()}`
              : "N/A"
          }`,
          "",
          "Types:",
          ...top(types).map(([name, value]) => `  ${name}: ${value}`),
        ];

        if (Object.keys(topics).length) {
          output.push("", "Top topics:");
          for (const [name, value] of top(topics)) output.push(`  ${name}: ${value}`);
        }

        if (Object.keys(people).length) {
          output.push("", "People mentioned:");
          for (const [name, value] of top(people)) output.push(`  ${name}: ${value}`);
        }

        return { content: [{ type: "text" as const, text: output.join("\n") }] };
      } finally {
        client.release();
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a thought with Gemini-generated embedding and metadata.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata, fingerprint] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
        sha256Hex(content),
      ]);

      const embeddingText = `[${embedding.join(",")}]`;
      const mergedMetadata = {
        ...metadata,
        source: "mcp",
        embedding_model: EMBEDDING_MODEL,
        metadata_model: CHAT_MODEL,
      };

      const client = await pool.connect();
      try {
        await client.queryObject(
          `INSERT INTO thoughts (content, embedding, metadata, content_fingerprint)
           VALUES ($1, $2::vector, $3::jsonb, $4)
           ON CONFLICT (content_fingerprint) DO UPDATE
           SET updated_at = now(),
               metadata = thoughts.metadata || EXCLUDED.metadata,
               embedding = EXCLUDED.embedding`,
          [content, embeddingText, JSON.stringify(mergedMetadata), fingerprint]
        );
      } finally {
        client.release();
      }

      const topics = Array.isArray(mergedMetadata.topics) ? mergedMetadata.topics.join(", ") : "";
      const people = Array.isArray(mergedMetadata.people) ? mergedMetadata.people.join(", ") : "";
      const actions = Array.isArray(mergedMetadata.action_items)
        ? mergedMetadata.action_items.join("; ")
        : "";

      let confirmation = `Captured as ${mergedMetadata.type || "thought"}`;
      if (topics) confirmation += ` - ${topics}`;
      if (people) confirmation += ` | People: ${people}`;
      if (actions) confirmation += ` | Actions: ${actions}`;

      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (context) => context.text("ok", 200, corsHeaders));

app.all("*", async (context) => {
  const provided =
    context.req.header("x-brain-key") ||
    new URL(context.req.url).searchParams.get("key");

  if (!provided || provided !== MCP_ACCESS_KEY) {
    return context.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  if (!context.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(context.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(context.req.raw.url, {
      method: context.req.raw.method,
      headers,
      body: context.req.raw.body,
      // @ts-ignore Deno needs duplex for streaming request bodies.
      duplex: "half",
    });
    Object.defineProperty(context.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(context);
});

await ensureSchema();
console.log(`Open Brain local Gemini MCP server listening on ${MCP_PORT}`);
Deno.serve({ port: MCP_PORT }, app.fetch);

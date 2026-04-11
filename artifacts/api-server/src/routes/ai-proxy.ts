import { Router, type Request, type Response } from "express";

const router = Router();

const PROXY_SECRET = process.env["CLAUDE_PROXY_SECRET"];
const ANTHROPIC_BASE_URL = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const ANTHROPIC_API_KEY = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];

function authOk(req: Request): boolean {
  const xApiKey = req.headers["x-api-key"];
  const auth = req.headers["authorization"];
  if (!PROXY_SECRET) return false;
  return xApiKey === PROXY_SECRET || auth === `Bearer ${PROXY_SECRET}`;
}

// ── Anthropic-native proxy (/v1/messages) ─────────────────────────────────────
router.post("/v1/messages", async (req: Request, res: Response) => {
  if (!authOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "Anthropic integration not configured" });
    return;
  }

  const upstream = `${ANTHROPIC_BASE_URL}/v1/messages`;
  const body = req.body;
  const isStream = body?.stream === true;

  const response = await fetch(upstream, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": (req.headers["anthropic-version"] as string) || "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const reader = response.body?.getReader();
    if (!reader) { res.end(); return; }
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } else {
    const data = (await response.json()) as unknown;
    res.status(response.status).json(data);
  }
});

// ── OpenAI-compatible proxy (/v1/chat/completions) ────────────────────────────
// Translates OpenAI format ↔ Anthropic format so OpenClaw (which uses OpenAI
// protocol) can use Claude via the Anthropic API proxy.
router.post("/v1/chat/completions", async (req: Request, res: Response) => {
  if (!authOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "Anthropic integration not configured" });
    return;
  }

  const oaiBody = req.body as {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    system?: string;
  };

  // Map OpenAI model names → Claude model
  const modelMap: Record<string, string> = {
    "gpt-4":       "claude-opus-4-5",
    "gpt-4o":      "claude-opus-4-5",
    "gpt-4-turbo": "claude-opus-4-5",
    "gpt-3.5-turbo": "claude-haiku-3-5",
  };
  const claudeModel = modelMap[oaiBody.model ?? ""] ?? "claude-opus-4-5";

  // Extract system message from messages array (Anthropic uses top-level system param)
  const msgs = oaiBody.messages ?? [];
  let systemPrompt: string | undefined;
  const userMsgs: Array<{ role: string; content: string }> = [];
  for (const m of msgs) {
    if (m.role === "system") {
      systemPrompt = m.content;
    } else {
      userMsgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }

  const anthropicBody: Record<string, unknown> = {
    model: claudeModel,
    messages: userMsgs,
    max_tokens: oaiBody.max_tokens ?? 4096,
    stream: oaiBody.stream ?? false,
  };
  if (systemPrompt) anthropicBody.system = systemPrompt;
  if (oaiBody.temperature !== undefined) anthropicBody.temperature = oaiBody.temperature;

  const upstream = `${ANTHROPIC_BASE_URL}/v1/messages`;
  const isStream = anthropicBody.stream === true;

  const response = await fetch(upstream, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  if (isStream) {
    // Stream: translate Anthropic SSE → OpenAI SSE on the fly
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = response.body?.getReader();
    if (!reader) { res.end(); return; }
    const decoder = new TextDecoder();
    let buf = "";

    // Send an OpenAI-style "role" chunk first
    const roleChunk = {
      id: `chatcmpl-oc${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: claudeModel,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const ev = JSON.parse(raw) as {
            type: string;
            delta?: { type: string; text?: string };
            message?: { stop_reason?: string };
          };

          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            const chunk = {
              id: `chatcmpl-oc${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: claudeModel,
              choices: [{ index: 0, delta: { content: ev.delta.text ?? "" }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (ev.type === "message_stop") {
            const stopChunk = {
              id: `chatcmpl-oc${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: claudeModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
    res.end();
  } else {
    // Non-streaming: translate Anthropic response → OpenAI response
    const anthropicResp = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
      stop_reason?: string;
      id?: string;
    };

    const text = anthropicResp.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("") ?? "";

    const oaiResp = {
      id: `chatcmpl-oc${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: claudeModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: anthropicResp.stop_reason === "end_turn" ? "stop" : anthropicResp.stop_reason,
        },
      ],
      usage: {
        prompt_tokens: anthropicResp.usage?.input_tokens ?? 0,
        completion_tokens: anthropicResp.usage?.output_tokens ?? 0,
        total_tokens:
          (anthropicResp.usage?.input_tokens ?? 0) + (anthropicResp.usage?.output_tokens ?? 0),
      },
    };
    res.status(response.status).json(oaiResp);
  }
});

router.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, proxy: "claude (anthropic + openai-compat)" });
});

export default router;

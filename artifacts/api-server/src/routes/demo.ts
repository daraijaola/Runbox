import { Router, type Request, type Response } from "express";
import { executeCode, executeCodeStream, SUPPORTED_LANGUAGES } from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";

const router = Router();

const DEMO_MAX_CODE_LENGTH = 1000;
const DEMO_TIMEOUT_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const AI_RATE_LIMIT_MAX = 5;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.ip ?? "unknown";
}

function checkRateLimit(ip: string, max: number): boolean {
  const now = Date.now();
  const key = `${ip}:${max}`;
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

const DEMO_LANGUAGES = [
  "python", "javascript", "bash", "go", "rust", "ruby",
  "c", "cpp", "php", "perl", "lua", "r", "java",
];

router.post("/run", async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, RATE_LIMIT_MAX_REQUESTS)) {
    res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
    return;
  }

  const { language, code } = req.body ?? {};
  if (!language || !code) {
    res.status(400).json({ error: "language and code are required" });
    return;
  }
  if (typeof code !== "string" || code.length > DEMO_MAX_CODE_LENGTH) {
    res.status(400).json({ error: `Code must be <= ${DEMO_MAX_CODE_LENGTH} characters` });
    return;
  }
  const lang = language.toLowerCase().trim();
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    res.status(400).json({ error: `Unsupported language. Supported: ${DEMO_LANGUAGES.join(", ")}` });
    return;
  }

  try {
    const result = await executeCode(lang, code, DEMO_TIMEOUT_MS);
    logger.info({ ip, language: lang, exitCode: result.exitCode, ms: result.executionMs }, "Demo execution");
    res.json(result);
  } catch (err) {
    logger.error({ err, language: lang }, "Demo execution error");
    res.status(500).json({ error: "Execution failed" });
  }
});

router.get("/run-stream", (req: Request, res: Response) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, RATE_LIMIT_MAX_REQUESTS)) {
    res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
    return;
  }

  const language = (req.query.language as string ?? "").toLowerCase().trim();
  const code = req.query.code as string ?? "";

  if (!language || !code) {
    res.status(400).json({ error: "language and code query params are required" });
    return;
  }
  if (code.length > DEMO_MAX_CODE_LENGTH) {
    res.status(400).json({ error: `Code must be <= ${DEMO_MAX_CODE_LENGTH} characters` });
    return;
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    res.status(400).json({ error: "Unsupported language" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const { kill } = executeCodeStream(language, code, {
    onStdout: (data: string) => {
      res.write(`data: ${JSON.stringify({ type: "stdout", data })}\n\n`);
    },
    onStderr: (data: string) => {
      res.write(`data: ${JSON.stringify({ type: "stderr", data })}\n\n`);
    },
    onExit: (exitCode: number, executionMs: number) => {
      res.write(`data: ${JSON.stringify({ type: "exit", exitCode, executionMs })}\n\n`);
      res.end();
    },
  });

  req.on("close", () => { kill(); });
});

const SYSTEM_PROMPT = `You are RunBox AI — a code execution assistant. The user asks a question or requests a computation. You MUST respond with executable code that answers their question.

Rules:
- Write ONLY the code, wrapped in a single fenced code block with the language tag
- Choose the best language for the task (default to Python)
- Supported languages: python, javascript, bash, go, rust, ruby, c, cpp, php, perl, lua, r, java
- The code must print its output to stdout
- Keep code concise and efficient
- No explanations outside the code block
- Maximum ~50 lines of code

Example response format:
\`\`\`python
print("Hello, world!")
\`\`\``;

router.post("/ai", async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, AI_RATE_LIMIT_MAX)) {
    res.status(429).json({ error: "AI rate limit exceeded. Try again in a minute." });
    return;
  }

  if (!ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "AI service not configured. Set ANTHROPIC_API_KEY environment variable." });
    return;
  }

  const { prompt } = req.body ?? {};
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  if (prompt.length > 500) {
    res.status(400).json({ error: "Prompt must be <= 500 characters" });
    return;
  }

  try {
    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      logger.error({ status: aiResponse.status, errText }, "Anthropic API error");
      const isCredits = errText.includes("credit balance");
      res.status(502).json({
        error: isCredits
          ? "AI service temporarily unavailable (API credits depleted). The Playground tab still works — try running code there!"
          : "AI service error",
      });
      return;
    }

    const aiData = await aiResponse.json() as { content: Array<{ type: string; text: string }> };
    const aiText = aiData.content?.find((c: { type: string }) => c.type === "text")?.text ?? "";

    const codeBlockMatch = aiText.match(/```(\w+)\n([\s\S]*?)```/);
    if (!codeBlockMatch) {
      res.json({ aiResponse: aiText, language: null, code: null, error: "AI did not produce a code block" });
      return;
    }

    const language = codeBlockMatch[1].toLowerCase();
    const code = codeBlockMatch[2].trim();

    if (!SUPPORTED_LANGUAGES.includes(language)) {
      res.json({ aiResponse: aiText, language, code, error: `Unsupported language: ${language}` });
      return;
    }

    const result = await executeCode(language, code, DEMO_TIMEOUT_MS);
    logger.info({ ip, prompt: prompt.slice(0, 80), language, exitCode: result.exitCode, ms: result.executionMs }, "AI demo execution");

    res.json({
      aiResponse: aiText,
      language,
      code,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      executionMs: result.executionMs,
    });
  } catch (err) {
    logger.error({ err }, "AI demo error");
    res.status(500).json({ error: "AI execution failed" });
  }
});

router.get("/languages", (_req: Request, res: Response) => {
  res.json({ languages: DEMO_LANGUAGES });
});

export default router;

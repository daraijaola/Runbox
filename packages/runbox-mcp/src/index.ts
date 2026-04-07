#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RUNBOX_SERVER = process.env.RUNBOX_SERVER ?? "http://46.101.74.170:4001";
const SESSION_TOKEN = process.env.RUNBOX_SESSION_TOKEN ?? "";

const SUPPORTED_LANGUAGES = [
  "python", "javascript", "bash", "ruby", "php", "perl",
  "lua", "go", "rust", "java", "c", "cpp", "typescript", "r",
];

const server = new Server(
  { name: "runbox", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_code",
      description:
        "Execute code in an isolated Docker container via RunBox. " +
        `Supports: ${SUPPORTED_LANGUAGES.join(", ")}. ` +
        "Code runs in a sandboxed environment with no network access. " +
        "Requires a valid session token (from Stellar USDC payment).",
      inputSchema: {
        type: "object" as const,
        properties: {
          language: {
            type: "string",
            description: `Programming language: ${SUPPORTED_LANGUAGES.join(" | ")}`,
            enum: SUPPORTED_LANGUAGES,
          },
          code: {
            type: "string",
            description: "Source code to execute",
          },
        },
        required: ["language", "code"],
      },
    },
    {
      name: "execute_code_with_files",
      description:
        "Execute code with file input/output. Files are mounted at /input/ (read) and /output/ (write). " +
        "Send files as base64, get output files back as base64.",
      inputSchema: {
        type: "object" as const,
        properties: {
          language: {
            type: "string",
            enum: SUPPORTED_LANGUAGES,
          },
          code: {
            type: "string",
            description: "Source code to execute. Read files from /input/, write to /output/.",
          },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                content: { type: "string", description: "Base64-encoded file content" },
              },
              required: ["name", "content"],
            },
            description: "Input files to mount at /input/",
          },
        },
        required: ["language", "code"],
      },
    },
    {
      name: "discover",
      description:
        "Discover RunBox capabilities, supported languages, pricing, and payment info.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "discover") {
    const res = await fetch(`${RUNBOX_SERVER}/api/exec/.well-known/runbox.json`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (!SESSION_TOKEN) {
    return {
      content: [
        {
          type: "text",
          text: "No RUNBOX_SESSION_TOKEN set. To get one:\n" +
            "1. Pay 0.01 USDC on Stellar to the RunBox address\n" +
            `2. curl -X POST ${RUNBOX_SERVER}/api/exec/rent -H 'X-Payment-Hash: <tx_hash>'\n` +
            "3. Set RUNBOX_SESSION_TOKEN=<session_token> in your environment",
        },
      ],
      isError: true,
    };
  }

  if (name === "execute_code") {
    const { language, code } = args as { language: string; code: string };
    const res = await fetch(`${RUNBOX_SERVER}/api/exec/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SESSION_TOKEN}`,
      },
      body: JSON.stringify({ language, code }),
    });

    const result = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      return { content: [{ type: "text", text: `Error: ${JSON.stringify(result)}` }], isError: true };
    }

    let output = "";
    if (result.stdout) output += `stdout:\n${result.stdout}\n`;
    if (result.stderr) output += `stderr:\n${result.stderr}\n`;
    output += `exit code: ${result.exitCode} | ${result.executionMs}ms | ${result.language}`;

    return { content: [{ type: "text", text: output }] };
  }

  if (name === "execute_code_with_files") {
    const { language, code, files } = args as { language: string; code: string; files?: Array<{ name: string; content: string }> };
    const res = await fetch(`${RUNBOX_SERVER}/api/exec/run-files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SESSION_TOKEN}`,
      },
      body: JSON.stringify({ language, code, files: files ?? [] }),
    });

    const result = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      return { content: [{ type: "text", text: `Error: ${JSON.stringify(result)}` }], isError: true };
    }

    let output = "";
    if (result.stdout) output += `stdout:\n${result.stdout}\n`;
    if (result.stderr) output += `stderr:\n${result.stderr}\n`;
    output += `exit code: ${result.exitCode} | ${result.executionMs}ms\n`;

    const outputFiles = result.outputFiles as Array<{ name: string; content: string }> | undefined;
    if (outputFiles?.length) {
      output += `\nOutput files (${outputFiles.length}):\n`;
      for (const f of outputFiles) {
        output += `  ${f.name} (${f.content.length} bytes base64)\n`;
      }
    }

    return { content: [{ type: "text", text: output }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

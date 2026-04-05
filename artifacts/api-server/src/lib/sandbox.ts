import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "./logger.js";

const execAsync = promisify(exec);

const SANDBOX_URL = process.env.SANDBOX_URL;
const MAX_EXEC_TIMEOUT_MS = 60_000;

interface LanguageConfig {
  image: string;
  inline: boolean;
  cmd: string;
}

const LANGUAGES: Record<string, LanguageConfig> = {
  python: { image: "runbox-python:latest", inline: false, cmd: "python3 /tmp/code.py" },
  python3: { image: "runbox-python:latest", inline: false, cmd: "python3 /tmp/code.py" },
  javascript: { image: "node:20-alpine", inline: true, cmd: "node -e" },
  js: { image: "node:20-alpine", inline: true, cmd: "node -e" },
  node: { image: "node:20-alpine", inline: true, cmd: "node -e" },
  bash: { image: "ubuntu:22.04", inline: true, cmd: "bash -c" },
  sh: { image: "ubuntu:22.04", inline: true, cmd: "sh -c" },
  ruby: { image: "ruby:3.2-alpine", inline: true, cmd: "ruby -e" },
  php: { image: "php:8.2-cli-alpine", inline: true, cmd: "php -r" },
  perl: { image: "perl:5.38", inline: true, cmd: "perl -e" },
  lua: { image: "nickblah/lua:5.4", inline: true, cmd: "lua -e" },
  go: { image: "golang:1.21-alpine", inline: false, cmd: "go run /tmp/code.go" },
  rust: { image: "rust:1.73-slim", inline: false, cmd: "bash -c 'echo \"$CODE\" > /tmp/main.rs && rustc /tmp/main.rs -o /tmp/out && /tmp/out'" },
  java: { image: "openjdk:21-slim", inline: false, cmd: "java" },
  c: { image: "gcc:13", inline: false, cmd: "bash -c 'echo \"$CODE\" | gcc -x c - -o /tmp/out && /tmp/out'" },
  cpp: { image: "gcc:13", inline: false, cmd: "bash -c 'echo \"$CODE\" | g++ -x c++ - -o /tmp/out && /tmp/out'" },
  typescript: { image: "node:20-alpine", inline: false, cmd: "bash -c 'echo \"$CODE\" > /tmp/code.ts && npx ts-node /tmp/code.ts'" },
  ts: { image: "node:20-alpine", inline: false, cmd: "bash -c 'echo \"$CODE\" > /tmp/code.ts && npx ts-node /tmp/code.ts'" },
  r: { image: "r-base:4.3.0", inline: true, cmd: "Rscript -e" },
};

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES);

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionMs: number;
  language: string;
  engine: "local" | "remote";
}

export async function executeCode(
  language: string,
  code: string,
  timeoutMs = MAX_EXEC_TIMEOUT_MS,
): Promise<ExecutionResult> {
  const start = Date.now();
  const lang = language.toLowerCase().trim();

  if (SANDBOX_URL) {
    return executeRemote(lang, code, timeoutMs, start);
  }

  return executeLocal(lang, code, timeoutMs, start);
}

async function executeRemote(
  language: string,
  code: string,
  timeoutMs: number,
  start: number,
): Promise<ExecutionResult> {
  try {
    const response = await fetch(`${SANDBOX_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, code, timeout: Math.floor(timeoutMs / 1000) }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });

    if (!response.ok) {
      throw new Error(`Sandbox returned ${response.status}`);
    }

    const result = (await response.json()) as Omit<ExecutionResult, "engine">;
    return { ...result, executionMs: Date.now() - start, engine: "remote" };
  } catch (err: unknown) {
    logger.error({ err, language }, "Remote sandbox error");
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : "Remote sandbox unavailable",
      exitCode: 1,
      executionMs: Date.now() - start,
      language,
      engine: "remote",
    };
  }
}

async function executeLocal(
  language: string,
  code: string,
  timeoutMs: number,
  start: number,
): Promise<ExecutionResult> {
  const config = LANGUAGES[language];

  if (!config) {
    return {
      stdout: "",
      stderr: `Unsupported language: "${language}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
      exitCode: 1,
      executionMs: Date.now() - start,
      language,
      engine: "local",
    };
  }

  const escapedCode = code.replace(/'/g, "'\\''");
  const timeoutSecs = Math.floor(timeoutMs / 1000);

  let dockerCmd: string;
  let tmpCodeFile: string | null = null;

  if (config.inline) {
    dockerCmd = [
      "docker run --rm",
      "--network none",
      "--memory 256m",
      "--cpus 1.0",
      `--stop-timeout ${timeoutSecs}`,
      `--env CODE='${escapedCode}'`,
      config.image,
      config.cmd,
      `'${escapedCode}'`,
    ].join(" ");
  } else {
    // Write code to a host temp file and mount it into the container.
    // This avoids shell-quoting issues with long/complex code (matplotlib, etc.)
    const ext = language === "go" ? ".go"
              : language === "rust" ? ".rs"
              : language === "java" ? ".java"
              : language === "c" ? ".c"
              : language === "cpp" ? ".cpp"
              : language === "typescript" || language === "ts" ? ".ts"
              : ".py";
    tmpCodeFile = join(tmpdir(), `runbox-${Date.now()}${ext}`);
    writeFileSync(tmpCodeFile, code, "utf8");

    let runCmd = config.cmd;
    // For languages that use the generic bash -c wrapper, adapt
    if (config.cmd.startsWith("bash -c")) {
      runCmd = config.cmd;
    }

    dockerCmd = [
      "docker run --rm",
      "--network none",
      "--memory 512m",
      "--cpus 1.5",
      `--stop-timeout ${timeoutSecs}`,
      `-v ${tmpCodeFile}:/tmp/code${ext}:ro`,
      `--env CODE='${escapedCode}'`,
      config.image,
      runCmd,
    ].join(" ");
  }

  logger.debug({ language, dockerCmd: dockerCmd.slice(0, 200) }, "Executing code");

  try {
    const { stdout, stderr } = await execAsync(dockerCmd, {
      timeout: timeoutMs + 2_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB — enough for base64-encoded plots
    });

    return {
      stdout,
      stderr,
      exitCode: 0,
      executionMs: Date.now() - start,
      language,
      engine: "local",
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "Execution failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
      executionMs: Date.now() - start,
      language,
      engine: "local",
    };
  } finally {
    if (tmpCodeFile) {
      try { unlinkSync(tmpCodeFile); } catch { /* ignore */ }
    }
  }
}




// ── File I/O execution ───────────────────────────────────────────────────────

export interface FileInput {
  name: string;
  content: string; // base64 encoded
}

export interface FileOutput {
  name: string;
  content: string; // base64 encoded
}

export interface ExecutionResultWithFiles extends ExecutionResult {
  outputFiles: FileOutput[];
}

export async function executeCodeWithFiles(
  language: string,
  code: string,
  files: FileInput[] = [],
  timeoutMs = MAX_EXEC_TIMEOUT_MS,
): Promise<ExecutionResultWithFiles> {
  const start = Date.now();
  const lang = language.toLowerCase().trim();
  const config = LANGUAGES[lang];

  if (!config) {
    return {
      stdout: "",
      stderr: `Unsupported language: "${language}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
      exitCode: 1,
      executionMs: 0,
      language: lang,
      engine: "local",
      outputFiles: [],
    };
  }

  const workDir = join(tmpdir(), `runbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inputDir = join(workDir, "input");
  const outputDir = join(workDir, "output");

  const { mkdirSync, readdirSync, readFileSync, rmSync } = await import("fs");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  for (const file of files) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    writeFileSync(join(inputDir, safeName), Buffer.from(file.content, "base64"));
  }

  let dockerArgs: string[];
  if (config.inline) {
    dockerArgs = [
      "run", "--rm", "--network=none",
      "--memory=128m", "--cpus=0.5",
      "-v", `${inputDir}:/input:ro`,
      "-v", `${outputDir}:/output`,
      config.image, ...config.cmd.split(" "), code,
    ];
  } else if (lang === "python" || lang === "python3") {
    dockerArgs = [
      "run", "--rm", "--network=none",
      "--memory=128m", "--cpus=0.5",
      "-v", `${inputDir}:/input:ro`,
      "-v", `${outputDir}:/output`,
      "-e", `CODE=${code}`,
      config.image, "bash", "-c", `echo "$CODE" > /tmp/code.py && python3 /tmp/code.py`,
    ];
  } else {
    dockerArgs = [
      "run", "--rm", "--network=none",
      "--memory=128m", "--cpus=0.5",
      "-v", `${inputDir}:/input:ro`,
      "-v", `${outputDir}:/output`,
      "-e", `CODE=${code}`,
      config.image, "bash", "-c", config.cmd,
    ];
  }

  try {
    const dockerCmd = `docker ${dockerArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
    const { stdout, stderr } = await execAsync(dockerCmd, { timeout: timeoutMs });

    const outputFiles: FileOutput[] = [];
    try {
      const outFiles = readdirSync(outputDir);
      for (const fname of outFiles) {
        const data = readFileSync(join(outputDir, fname));
        outputFiles.push({ name: fname, content: data.toString("base64") });
      }
    } catch {}

    rmSync(workDir, { recursive: true, force: true });

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      executionMs: Date.now() - start,
      language: lang,
      engine: "local",
      outputFiles,
    };
  } catch (err: unknown) {
    const outputFiles: FileOutput[] = [];
    try {
      const outFiles = readdirSync(outputDir);
      for (const fname of outFiles) {
        const data = readFileSync(join(outputDir, fname));
        outputFiles.push({ name: fname, content: data.toString("base64") });
      }
    } catch {}

    rmSync(workDir, { recursive: true, force: true });

    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
      exitCode: typeof e.code === "number" ? e.code : 1,
      executionMs: Date.now() - start,
      language: lang,
      engine: "local",
      outputFiles,
    };
  }
}

// ── Streaming execution ──────────────────────────────────────────────────────

import { spawn } from "child_process";

export interface StreamCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (exitCode: number, executionMs: number) => void;
}

export function executeCodeStream(
  language: string,
  code: string,
  callbacks: StreamCallbacks,
  timeoutMs = MAX_EXEC_TIMEOUT_MS,
): { kill: () => void } {
  const start = Date.now();
  const lang = language.toLowerCase().trim();
  const config = LANGUAGES[lang];

  if (!config) {
    callbacks.onStderr(`Unsupported language: "${language}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
    callbacks.onExit(1, 0);
    return { kill: () => {} };
  }

  let args: string[];
  if (config.inline) {
    args = [
      "run", "--rm", "--network=none",
      "--memory=128m", "--cpus=0.5",
      config.image, ...config.cmd.split(" "), code,
    ];
  } else if (lang === "python" || lang === "python3") {
    args = [
      "run", "--rm", "--network=none",
      "--memory=128m", "--cpus=0.5",
      "-e", `CODE=${code}`,
      config.image, "bash", "-c", `echo "$CODE" > /tmp/code.py && python3 /tmp/code.py`,
    ];
  } else {
    args = [
      "run", "--rm", "--network=none",
      "--memory=128m", "--cpus=0.5",
      "-e", `CODE=${code}`,
      config.image, "bash", "-c", config.cmd,
    ];
  }

  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    callbacks.onStderr("Execution timed out");
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => {
    callbacks.onStdout(chunk.toString());
  });

  child.stderr.on("data", (chunk: Buffer) => {
    callbacks.onStderr(chunk.toString());
  });

  child.on("close", (exitCode: number | null) => {
    clearTimeout(timer);
    callbacks.onExit(exitCode ?? 1, Date.now() - start);
  });

  child.on("error", (err: Error) => {
    clearTimeout(timer);
    callbacks.onStderr(err.message);
    callbacks.onExit(1, Date.now() - start);
  });

  return { kill: () => { clearTimeout(timer); child.kill("SIGKILL"); } };
}

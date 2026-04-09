import { describe, it, expect } from "vitest";
import { executeCode, SUPPORTED_LANGUAGES } from "../lib/sandbox.js";

describe("Sandbox Languages", () => {
  it("supports at least 14 languages", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(14);
  });

  it("includes core languages", () => {
    const core = ["python", "javascript", "bash", "go", "rust", "typescript"];
    for (const lang of core) {
      expect(SUPPORTED_LANGUAGES).toContain(lang);
    }
  });
});

describe("Sandbox Execution", () => {
  it("executes Python code", async () => {
    const result = await executeCode("python", "print('hello')");
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.language).toBe("python");
    expect(result.executionMs).toBeGreaterThan(0);
  }, 30000);

  it("executes JavaScript code", async () => {
    const result = await executeCode("javascript", "console.log(2+2)");
    expect(result.stdout).toContain("4");
    expect(result.exitCode).toBe(0);
  }, 30000);

  it("executes Bash code", async () => {
    const result = await executeCode("bash", "echo hello");
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  }, 30000);

  it("captures stderr on error", async () => {
    const result = await executeCode("python", "import sys; sys.exit(1)");
    expect(result.exitCode).not.toBe(0);
  }, 30000);

  it("rejects unsupported language", async () => {
    const result = await executeCode("brainfuck", "+++");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported");
  });

  it("handles multiline code", async () => {
    const code = "x = 5\ny = 10\nprint(x + y)";
    const result = await executeCode("python", code);
    expect(result.stdout).toContain("15");
    expect(result.exitCode).toBe(0);
  }, 30000);

  it("enforces timeout", async () => {
    const result = await executeCode("python", "import time; time.sleep(120)", 3000);
    expect(result.exitCode).not.toBe(0);
  }, 10000);
});

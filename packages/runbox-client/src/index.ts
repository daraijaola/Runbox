export interface RunBoxConfig {
  server?: string;
  sessionToken?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionMs: number;
  language: string;
  engine: string;
}

export interface FileInput {
  name: string;
  content: string;
}

export interface FileOutput {
  name: string;
  content: string;
}

export interface ExecResultWithFiles extends ExecResult {
  outputFiles: FileOutput[];
}

export interface StreamEvent {
  type: "stdout" | "stderr" | "exit";
  data?: string;
  exitCode?: number;
  executionMs?: number;
}

export interface RentResult {
  session_token: string;
  session_id: string;
  expires_at: string;
  minutes_granted: number;
  payment: { tx_hash: string; amount_paid: string; payer: string };
}

export interface MppExecResult extends ExecResult {
  execution_ms: number;
  payment: { protocol: string; network: string };
}

export class RunBox {
  private server: string;
  private sessionToken: string | null;

  constructor(config: RunBoxConfig = {}) {
    this.server = (config.server ?? "http://46.101.74.170:4001").replace(/\/$/, "");
    this.sessionToken = config.sessionToken ?? null;
  }

  async discover(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.server}/api/exec/.well-known/runbox.json`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  async rent(txHash: string, minutes?: number): Promise<RentResult> {
    const url = minutes
      ? `${this.server}/api/exec/rent?minutes=${minutes}`
      : `${this.server}/api/exec/rent`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Payment-Hash": txHash },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>;
      throw new Error(body.error ?? `rent failed: ${res.status}`);
    }

    const data = await res.json() as RentResult;
    this.sessionToken = data.session_token;
    return data;
  }

  async exec(language: string, code: string): Promise<ExecResult> {
    if (!this.sessionToken) throw new Error("No session — call rent() first or pass sessionToken");

    const res = await fetch(`${this.server}/api/exec/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({ language, code }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>;
      throw new Error(body.error ?? `exec failed: ${res.status}`);
    }

    return res.json() as Promise<ExecResult>;
  }

  async execWithFiles(
    language: string,
    code: string,
    files: FileInput[] = [],
  ): Promise<ExecResultWithFiles> {
    if (!this.sessionToken) throw new Error("No session — call rent() first or pass sessionToken");

    const res = await fetch(`${this.server}/api/exec/run-files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({ language, code, files }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>;
      throw new Error(body.error ?? `exec-files failed: ${res.status}`);
    }

    return res.json() as Promise<ExecResultWithFiles>;
  }

  async *execStream(language: string, code: string): AsyncGenerator<StreamEvent> {
    if (!this.sessionToken) throw new Error("No session — call rent() first or pass sessionToken");

    const res = await fetch(`${this.server}/api/exec/run-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({ language, code }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`exec-stream failed: ${res.status} ${body}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            yield JSON.parse(line.slice(6)) as StreamEvent;
          } catch {}
        }
      }
    }
  }

  async mppExec(language: string, code: string): Promise<MppExecResult | { status: 402; headers: Record<string, string>; body: unknown }> {
    const res = await fetch(`${this.server}/api/mpp/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, code }),
    });

    if (res.status === 402) {
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const body = await res.json().catch(() => ({}));
      return { status: 402, headers, body };
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>;
      throw new Error(body.error ?? `mpp-exec failed: ${res.status}`);
    }

    return res.json() as Promise<MppExecResult>;
  }
}

export default RunBox;

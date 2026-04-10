# runbox-client

RunBox client SDK — pay-per-use isolated code execution for AI agents on Stellar.

## Install

```bash
npm install runbox-client
```

## Usage

```typescript
import { RunBox } from "runbox-client";

const box = new RunBox();

// 1. Pay for a session (x402 flow)
const session = await box.rent("<stellar_tx_hash>");

// 2. Execute code
const result = await box.exec("python", "print('hello from RunBox')");
console.log(result.stdout); // "hello from RunBox"

// 3. Stream output
for await (const event of box.execStream("python", "for i in range(5): print(i)")) {
  if (event.type === "stdout") process.stdout.write(event.data!);
}

// 4. File I/O
const fileResult = await box.execWithFiles("python",
  "open('/output/result.txt','w').write(open('/input/data.txt').read().upper())",
  [{ name: "data.txt", content: btoa("hello world") }]
);
console.log(atob(fileResult.outputFiles[0].content)); // "HELLO WORLD"

// 5. MPP (pay-per-request, no session needed)
const mppResult = await box.mppExec("python", "print(42)");
```

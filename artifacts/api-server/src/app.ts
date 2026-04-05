import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Resolve the public dir relative to the bundle (dist/ → ../public/)
// __dirname = dirname(fileURLToPath(import.meta.url)) which is dist/ at runtime
const publicDir = join(__dirname, "..", "public");

// Serve public assets (demo page etc.)
app.use("/public", express.static(publicDir));

// Direct demo route — serves the HTML file
app.get(["/demo", "/api/demo"], (_req, res) => {
  res.sendFile(join(publicDir, "demo.html"));
});

export default app;

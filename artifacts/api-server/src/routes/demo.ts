import { Router, type IRouter } from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const router: IRouter = Router();

router.get("/", (_req, res) => {
  try {
    const html = readFileSync(join(__dirname, "../../public/demo.html"), "utf-8");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch {
    res.status(404).send("Demo page not found");
  }
});

export default router;

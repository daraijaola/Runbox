import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import execRouter from "./exec.js";
import aiProxyRouter from "./ai-proxy.js";
import mppExecRouter from "./mpp-exec.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/exec", execRouter);
router.use("/ai-proxy", aiProxyRouter);
router.use("/mpp", mppExecRouter);

export default router;

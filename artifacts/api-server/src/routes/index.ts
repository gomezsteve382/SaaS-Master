import { Router, type IRouter } from "express";
import healthRouter from "./health";
import downloadsRouter from "./downloads";
import backupsRouter from "./backups";
import diffReportsRouter from "./diffReports";
import anthropicRouter from "./anthropic";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadsRouter);
router.use(backupsRouter);
router.use(diffReportsRouter);
router.use("/anthropic", anthropicRouter);

export default router;

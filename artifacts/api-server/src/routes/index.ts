import { Router, type IRouter } from "express";
import healthRouter from "./health";
import downloadsRouter from "./downloads";
import backupsRouter from "./backups";
import diffReportsRouter from "./diffReports";
import keyProgArchivesRouter from "./keyProgArchives";
import anthropicRouter from "./anthropic";
import vehicleJobsRouter from "./vehicleJobs";
import unlockCoverageRouter from "./unlockCoverage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadsRouter);
router.use(backupsRouter);
router.use(diffReportsRouter);
router.use(keyProgArchivesRouter);
router.use(vehicleJobsRouter);
router.use(unlockCoverageRouter);
router.use("/anthropic", anthropicRouter);

export default router;

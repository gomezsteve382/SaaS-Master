import { Router, type IRouter } from "express";
import healthRouter from "./health";
import downloadsRouter from "./downloads";
import backupsRouter from "./backups";
import diffReportsRouter from "./diffReports";
import keyProgArchivesRouter from "./keyProgArchives";
import anthropicRouter from "./anthropic";
import vehicleJobsRouter from "./vehicleJobs";
import unlockCoverageRouter from "./unlockCoverage";
import auth29DetectionsRouter from "./auth29Detections";
import signalDiscoveryRouter from "./signalDiscovery";
import integrationTasksRouter from "./integrationTasks";
import bcmCatalogProposalsRouter from "./bcmCatalogProposals";
import task634VerificationsRouter from "./task634Verifications";
import sec16SyncEventsRouter from "./sec16SyncEvents";
import patternsRouter from "./patterns";
import knowledgeGraphRouter from "./knowledgeGraph";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadsRouter);
router.use(backupsRouter);
router.use(diffReportsRouter);
router.use(keyProgArchivesRouter);
router.use(vehicleJobsRouter);
router.use(unlockCoverageRouter);
router.use(auth29DetectionsRouter);
router.use(signalDiscoveryRouter);
router.use(integrationTasksRouter);
router.use(bcmCatalogProposalsRouter);
router.use(task634VerificationsRouter);
router.use(sec16SyncEventsRouter);
router.use(patternsRouter);
router.use(knowledgeGraphRouter);
router.use("/anthropic", anthropicRouter);

export default router;

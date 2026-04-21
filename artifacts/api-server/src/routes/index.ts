import { Router, type IRouter } from "express";
import healthRouter from "./health";
import downloadsRouter from "./downloads";
import backupsRouter from "./backups";
import diffReportsRouter from "./diffReports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadsRouter);
router.use(backupsRouter);
router.use(diffReportsRouter);

export default router;

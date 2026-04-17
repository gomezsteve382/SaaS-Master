import { Router, type IRouter } from "express";
import healthRouter from "./health";
import downloadsRouter from "./downloads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadsRouter);

export default router;

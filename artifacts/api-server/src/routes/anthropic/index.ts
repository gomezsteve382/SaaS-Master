import { Router } from "express";
import moduleAssistantRouter from "./moduleAssistant";

const router = Router();

router.use(moduleAssistantRouter);

export default router;

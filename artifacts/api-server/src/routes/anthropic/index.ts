import { Router } from "express";
import moduleAssistantRouter from "./moduleAssistant";
import conversationsRouter from "./conversations";

const router = Router();

router.use(moduleAssistantRouter);
router.use(conversationsRouter);

export default router;

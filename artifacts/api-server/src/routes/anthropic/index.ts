import { Router } from "express";
import moduleAssistantRouter from "./moduleAssistant";
import conversationsRouter from "./conversations";
import toolMessagesRouter from "./toolMessages";

const router = Router();

router.use(moduleAssistantRouter);
router.use(conversationsRouter);
router.use(toolMessagesRouter);

export default router;

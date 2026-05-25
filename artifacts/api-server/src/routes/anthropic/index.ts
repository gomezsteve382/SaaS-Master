import { Router } from "express";
import moduleAssistantRouter from "./moduleAssistant";
import conversationsRouter from "./conversations";
import toolMessagesRouter from "./toolMessages";
import investigationSwarmRouter from "./investigationSwarm/index";

const router = Router();

router.use(moduleAssistantRouter);
router.use(conversationsRouter);
router.use(toolMessagesRouter);
router.use(investigationSwarmRouter);

export default router;

import { Router } from "express";
import moduleAssistantRouter from "./moduleAssistant";
import generalChatRouter from "./generalChat";
import conversationsRouter from "./conversations";
import toolMessagesRouter from "./toolMessages";
import investigationSwarmRouter from "./investigationSwarm/index";
import keyPhotoRouter from "./keyPhoto";

const router = Router();

router.use(moduleAssistantRouter);
router.use(generalChatRouter);
router.use(conversationsRouter);
router.use(toolMessagesRouter);
router.use(investigationSwarmRouter);
router.use(keyPhotoRouter);

export default router;

import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Replit dev/prod domains are multi-label hostnames like
//   <repl-id>-<port>.<region>.replit.dev
// or  <slug>.<owner>.repl.co. The previous regex only allowed a single
// label before the suffix, which incorrectly rejected every modern dev
// preview origin (Task #501). Allow any number of dot/hyphen-separated
// labels in the prefix.
const allowedOriginRe =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^https:\/\/[a-z0-9.-]+\.(repl\.co|replit\.app|replit\.dev)(\/.*)?$/i;
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin requests (no Origin header) and matching Replit/localhost origins
      if (!origin || allowedOriginRe.test(origin)) {
        cb(null, true);
      } else {
        cb(new Error("CORS: origin not permitted"));
      }
    },
    credentials: true,
  }),
);
/* Task #694 — raise the JSON body limit so the AI assistant's tool-use
 * endpoint can accept loaded module binaries (a 128KB BCM dump base64s
 * to ~170KB, and the multi-binary payload bundles several modules). The
 * old ~100KB default rejected real bench dumps with a 413. */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

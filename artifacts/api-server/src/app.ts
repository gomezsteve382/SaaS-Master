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
const allowedOriginRe =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^https:\/\/[a-z0-9-]+\.(repl\.co|replit\.app|replit\.dev)(\/.*)?$/i;
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

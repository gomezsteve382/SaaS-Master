import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

// Create MySQL connection pool
const pool = mysql.createPool({
  uri: DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
});

export const db = drizzle(pool, { schema, mode: "default" });
export type DB = typeof db;

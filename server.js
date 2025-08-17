// ================================
// 🌍 Location Tracking Server
// ================================

// Load environment variables
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { WebSocketServer } from "ws";
import Joi from "joi";
import { pool, ensureSchema } from "./db.js";

// Swagger imports
import swaggerJSDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "localhost";

// ================================
// 🔐 Security & Middleware
// ================================
app.use(helmet());
app.use(express.json({ limit: "256kb" }));

// ✅ Allow all origins
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Basic rate limit: 120 requests/minute per IP
const limiter = new RateLimiterMemory({ points: 120, duration: 60 });
app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    next();
  } catch {
    res.status(429).json({ success: false, error: "Too many requests" });
  }
});

// ================================
// 📜 Swagger Setup
// ================================
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Employee Location API",
      version: "1.0.0",
      description:
        "API documentation for real-time employee location tracking system",
    },
    servers: [
      {
        url: `http://${HOST}:${PORT}`,
        description: "Local server",
      },
    ],
  },
  apis: ["./server.js"], // Documentation is inside this file
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);
app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ================================
// 📦 Joi Schema
// ================================
const locationSchema = Joi.object({
  employee_id: Joi.number().integer().min(1).required(),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  gps_status: Joi.string().valid("on", "off").required(),
  timestamp: Joi.string().isoDate().optional(),
});

// ================================
// 🩺 Health Check
// ================================
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check for server & DB
 *     responses:
 *       200:
 *         description: Server is healthy
 */
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(500).json({ status: "db_error" });
  }
});

// ================================
// 📍 Location APIs
// ================================

/**
 * @swagger
 * /api/location:
 *   post:
 *     summary: Insert or update employee live location
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_id, latitude, longitude, gps_status]
 *             properties:
 *               employee_id:
 *                 type: integer
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               gps_status:
 *                 type: string
 *                 enum: [on, off]
 *     responses:
 *       200:
 *         description: Location updated successfully
 */
app.post("/api/location", async (req, res) => {
  const { error, value } = locationSchema.validate(req.body);
  if (error)
    return res.status(400).json({ success: false, error: error.message });

  const { employee_id, latitude, longitude, gps_status } = value;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ✅ Update live location
    await conn.query(
      `INSERT INTO employee_live_location (employee_id, latitude, longitude, gps_status, last_update)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude), gps_status=VALUES(gps_status), last_update=NOW()`,
      [employee_id, latitude, longitude, gps_status]
    );

    // ✅ Save in history
    await conn.query(
      `INSERT INTO employee_location_history (employee_id, latitude, longitude, gps_status, recorded_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [employee_id, latitude, longitude, gps_status]
    );

    await conn.commit();

    const payload = {
      employee_id,
      latitude,
      longitude,
      gps_status,
      last_update: new Date().toISOString(),
    };

    // ✅ Broadcast via WebSocket
    broadcast(payload);

    res.json({ success: true, message: "Location updated", data: payload });
  } catch (e) {
    await conn.rollback();
    console.error("DB error:", e);
    res.status(500).json({ success: false, error: "Database error" });
  } finally {
    conn.release();
  }
});

/**
 * @swagger
 * /api/locations:
 *   get:
 *     summary: Get all employees' latest locations
 *     responses:
 *       200:
 *         description: List of latest employee locations
 */
app.get("/api/locations", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT employee_id, latitude, longitude, gps_status, last_update FROM v_employee_latest"
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

/**
 * @swagger
 * /api/locations/{employee_id}/history:
 *   get:
 *     summary: Get location history of a specific employee
 *     parameters:
 *       - in: path
 *         name: employee_id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 500
 *           maximum: 5000
 *     responses:
 *       200:
 *         description: List of location history
 */
app.get("/api/locations/:employee_id/history", async (req, res) => {
  const employee_id = Number(req.params.employee_id);
  const limit = Math.min(Number(req.query.limit || 500), 5000);
  if (!employee_id)
    return res
      .status(400)
      .json({ success: false, error: "Invalid employee_id" });

  try {
    const [rows] = await pool.query(
      `SELECT employee_id, latitude, longitude, gps_status, recorded_at
       FROM employee_location_history
       WHERE employee_id = ?
       ORDER BY recorded_at DESC
       LIMIT ?`,
      [employee_id, limit]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// ================================
// 🚀 Start Express Server
// ================================
const server = app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`🚀 Location server running at: http://${HOST}:${PORT}`);
  console.log(`📖 Swagger docs available at: http://${HOST}:${PORT}/swagger`);
});

// ================================
// 🔌 WebSocket Setup
// ================================
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", ts: Date.now() }));
});

// Broadcast helper
function broadcast(obj) {
  const msg = JSON.stringify({ type: "location", payload: obj });
  wss.clients.forEach((c) => {
    try {
      c.send(msg);
    } catch {}
  });
}

// ================================
// 🛑 Graceful Shutdown
// ================================
function shutdown(sig) {
  console.log(`\n${sig} received, shutting down...`);
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => shutdown(s)));

// address-issue-server.js
// Poll ShipStation for orders with Address Validation Failed and auto-tag them "ADDRESS ISSUE"

const express = require("express");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "address-issue-queue.db");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000); // default 5 min

// Which ShipStation tag to apply
const ADDRESS_ISSUE_TAG_NAME = process.env.ADDRESS_ISSUE_TAG_NAME || "ADDRESS ISSUE";

// Which ShipStation order statuses to scan
// ShipStation list orders supports statuses like awaiting_shipment, on_hold, etc.
const ORDER_STATUSES = (process.env.ORDER_STATUSES || "awaiting_shipment,on_hold")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Lookback window (days) for modifyDateStart to reduce scanning load
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);

// Pagination
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);

// ShipStation creds
const SS_KEY = process.env.SHIPSTATION_API_KEY;
const SS_SECRET = process.env.SHIPSTATION_API_SECRET;

function requireEnv() {
  const missing = [];
  if (!SS_KEY) missing.push("SHIPSTATION_API_KEY");
  if (!SS_SECRET) missing.push("SHIPSTATION_API_SECRET");
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIPSTATION CLIENT
// ─────────────────────────────────────────────────────────────────────────────

function createShipStationClient() {
  return axios.create({
    baseURL: "https://ssapi.shipstation.com",
    auth: { username: SS_KEY, password: SS_SECRET },
    timeout: 15000,
  });
}

async function listOrders({ orderStatus, modifyDateStart, page }) {
  const client = createShipStationClient();
  const res = await client.get("/orders", {
    params: {
      orderStatus,
      modifyDateStart,
      page,
      pageSize: PAGE_SIZE,
      sortBy: "ModifyDate",
      sortDir: "DESC",
    },
  });

  // Response shape is typically { orders: [...], total, page, pages }
  return res.data || {};
}

async function getTagIdByName(tagName) {
  const client = createShipStationClient();
  const res = await client.get("/accounts/listtags");
  const tags = res.data?.tags || res.data || [];
  const match = tags.find(
    (t) => String(t.name || "").toLowerCase() === tagName.toLowerCase()
  );
  return match ? match.tagId : null;
}

async function addTagToOrder(orderId, tagId) {
  const client = createShipStationClient();
  await client.post("/orders/addtag", { orderId, tagId });
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLITE (dedupe + tracking)
// ─────────────────────────────────────────────────────────────────────────────

let db = null;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);

      const sql = `
        CREATE TABLE IF NOT EXISTS processed (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shipstation_order_id INTEGER NOT NULL,
          order_number TEXT,
          status TEXT NOT NULL DEFAULT 'tagged',
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(shipstation_order_id)
        );

        CREATE INDEX IF NOT EXISTS idx_processed_created_at ON processed(created_at);
      `;

      db.exec(sql, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function markProcessed(shipstationOrderId, orderNumber, status, note) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO processed (shipstation_order_id, order_number, status, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(shipstation_order_id) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `;
    db.run(sql, [shipstationOrderId, orderNumber, status, note], (err) =>
      err ? reject(err) : resolve()
    );
  });
}

function wasProcessed(shipstationOrderId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM processed WHERE shipstation_order_id = ? LIMIT 1`,
      [shipstationOrderId],
      (err, row) => (err ? reject(err) : resolve(!!row))
    );
  });
}

function getStats() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT status, COUNT(*) as count FROM processed GROUP BY status`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function getRecentProcessed(limit = 100) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM processed ORDER BY updated_at DESC LIMIT ?`,
      [limit],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC
// ─────────────────────────────────────────────────────────────────────────────

// According to ShipStation Address model, addressVerified may be:
// "Address not yet validated", "Address validated successfully",
// "Address validation warning", "Address validation failed"
const ADDRESS_FAILED_VALUE = "Address validation failed";

function isAddressVerificationFailed(order) {
  const av = order?.shipTo?.addressVerified;
  return String(av || "").toLowerCase() === ADDRESS_FAILED_VALUE.toLowerCase();
}

function formatIsoDateDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

async function scanAndTagAddressIssues(tagId) {
  const modifyDateStart = formatIsoDateDaysAgo(LOOKBACK_DAYS);

  console.log(`\n${"═".repeat(80)}`);
  console.log(`🔎 Scan started: ${new Date().toLocaleString()}`);
  console.log(`   Statuses: ${ORDER_STATUSES.join(", ")}`);
  console.log(`   modifyDateStart: ${modifyDateStart}`);
  console.log(`   Tag: ${ADDRESS_ISSUE_TAG_NAME} (tagId=${tagId})`);
  console.log(`${"═".repeat(80)}`);

  let foundFailed = 0;
  let newlyTagged = 0;
  let skippedAlready = 0;

  for (const status of ORDER_STATUSES) {
    let page = 1;
    while (true) {
      const data = await listOrders({ orderStatus: status, modifyDateStart, page });
      const orders = data.orders || [];

      if (orders.length === 0) break;

      for (const order of orders) {
        const orderId = order.orderId;
        const orderNumber = order.orderNumber || order.orderKey || "";

        if (!orderId) continue;

        if (!isAddressVerificationFailed(order)) continue;

        foundFailed += 1;

        // Dedupe: if we've already tagged this order, skip
        const already = await wasProcessed(orderId);
        if (already) {
          skippedAlready += 1;
          continue;
        }

        try {
          console.log(`⚠️  Address validation failed: Order ${orderNumber} (ID ${orderId})`);
          await addTagToOrder(orderId, tagId);
          await markProcessed(orderId, orderNumber, "tagged", "Tagged ADDRESS ISSUE");
          newlyTagged += 1;
          console.log(`✅ Tagged: ${orderNumber}`);
        } catch (e) {
          const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
          await markProcessed(orderId, orderNumber, "error", msg);
          console.log(`❌ Error tagging ${orderNumber}: ${msg}`);
        }

        // small delay to be gentle
        await new Promise((r) => setTimeout(r, 250));
      }

      // stop if no more pages
      const totalPages = data.pages || data.totalPages || 1;
      if (page >= totalPages) break;
      page += 1;
    }
  }

  console.log(`\n📌 Scan results:`);
  console.log(`   Address-failed found: ${foundFailed}`);
  console.log(`   Newly tagged: ${newlyTagged}`);
  console.log(`   Skipped (already processed): ${skippedAlready}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP (health + dashboard)
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    now: new Date().toISOString(),
    pollIntervalSeconds: Math.round(POLL_INTERVAL_MS / 1000),
  });
});

app.get("/", async (req, res) => {
  try {
    const stats = await getStats();
    const recent = await getRecentProcessed(50);

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Address Issue Tagger</title>
  <meta http-equiv="refresh" content="30" />
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 1100px; margin: 0 auto; padding: 20px; background: #f3f4f6; }
    h1 { color: #111827; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap: 12px; margin: 16px 0; }
    .card { background: white; border-radius: 10px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
    .num { font-size: 30px; font-weight: 800; }
    .label { color: #6b7280; font-size: 12px; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
    th { background: #111827; color: white; text-align: left; padding: 12px; font-size: 13px; }
    td { padding: 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; }
    .status-tagged { color: #065f46; font-weight: 700; }
    .status-error { color: #991b1b; font-weight: 700; }
    .muted { color: #6b7280; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🏷️ Address Issue Auto-Tagger</h1>
  <p class="muted">Auto-refreshes every 30s • Polls ShipStation every ${Math.round(POLL_INTERVAL_MS/1000)}s</p>

  <div class="cards">
    ${stats.map(s => `
      <div class="card">
        <div class="num">${s.count}</div>
        <div class="label">${String(s.status).toUpperCase()}</div>
      </div>
    `).join("")}
  </div>

  <div class="card">
    <div><strong>Tag:</strong> ${ADDRESS_ISSUE_TAG_NAME}</div>
    <div><strong>Statuses:</strong> ${ORDER_STATUSES.join(", ")}</div>
    <div><strong>Lookback:</strong> ${LOOKBACK_DAYS} days</div>
    <div><strong>DB:</strong> <code>${DB_PATH}</code></div>
  </div>

  <h2>Recent Processed</h2>
  <table>
    <thead>
      <tr>
        <th>Order #</th>
        <th>ShipStation Order ID</th>
        <th>Status</th>
        <th>Note / Error</th>
        <th>Updated</th>
      </tr>
    </thead>
    <tbody>
      ${recent.map(r => `
        <tr>
          <td><strong>${r.order_number || ""}</strong></td>
          <td>${r.shipstation_order_id}</td>
          <td class="status-${r.status}">${r.status}</td>
          <td class="muted">${(r.note || "").slice(0, 200)}</td>
          <td class="muted">${r.updated_at}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>
</body>
</html>
    `;
    res.send(html);
  } catch (e) {
    res.status(500).send("Dashboard error: " + e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`🚀 Starting Address Issue Tagger...`);
  console.log(`${"═".repeat(80)}\n`);

  const missing = requireEnv();
  if (missing.length) {
    console.error(`⚠️ Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  await initDatabase();
  console.log(`✅ SQLite ready: ${DB_PATH}`);

  // Ensure tag exists
  const tagId = await getTagIdByName(ADDRESS_ISSUE_TAG_NAME);
  if (!tagId) {
    console.error(
      `❌ Tag "${ADDRESS_ISSUE_TAG_NAME}" not found in ShipStation.\n` +
      `   Create it in ShipStation first, then restart this service.`
    );
    process.exit(1);
  }
  console.log(`✅ Using tag "${ADDRESS_ISSUE_TAG_NAME}" (tagId=${tagId})`);

  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/`);
    console.log(`🩺 Health: http://localhost:${PORT}/health`);
  });

  // Initial run + interval
  console.log(`🤖 Worker polling every ${Math.round(POLL_INTERVAL_MS / 1000)} seconds...`);
  await scanAndTagAddressIssues(tagId);
  setInterval(() => {
    scanAndTagAddressIssues(tagId).catch((e) =>
      console.error("Worker fatal error:", e.message)
    );
  }, POLL_INTERVAL_MS);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\nSIGTERM: closing DB...");
  if (db) db.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("\nSIGINT: closing DB...");
  if (db) db.close();
  process.exit(0);
});

start().catch((e) => {
  console.error("💥 Startup error:", e);
  process.exit(1);
});

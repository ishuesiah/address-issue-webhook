// shopify-address-poller.js
// Poll Shopify (2024-10 GraphQL) for orders with shippingAddress.validationResultSummary WARNING/ERROR
// Then tag matching ShipStation orders with "ADDRESS ISSUE"

const express = require("express");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// ENV / CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "shopify-address-poller.db");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000); // 5 min default
const LOOKBACK_MINUTES_ON_FIRST_RUN = Number(process.env.LOOKBACK_MINUTES_ON_FIRST_RUN || 24 * 60); // 24h

const ADDRESS_ISSUE_TAG_NAME = process.env.ADDRESS_ISSUE_TAG_NAME || "ADDRESS ISSUE";

// Optional: limit which orders we scan via Shopify order query filters.
// Example: "financial_status:paid" or "tag:'VIP'" etc.
// We'll always include updated_at >= lastPoll.
const SHOPIFY_EXTRA_QUERY = (process.env.SHOPIFY_EXTRA_QUERY || "").trim();

// Shopify
const SHOPIFY_SHOP_DOMAIN = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim(); // e.g. "hemlockandoak.myshopify.com"
const SHOPIFY_ADMIN_ACCESS_TOKEN = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim(); // Admin API token
const SHOPIFY_API_VERSION = "2024-10";

// ShipStation
const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;

// Debug
const DEBUG = (process.env.DEBUG || "true") === "true";

function missingEnvVars() {
  const missing = [];
  if (!SHOPIFY_SHOP_DOMAIN) missing.push("SHOPIFY_SHOP_DOMAIN");
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (!SHIPSTATION_API_KEY) missing.push("SHIPSTATION_API_KEY");
  if (!SHIPSTATION_API_SECRET) missing.push("SHIPSTATION_API_SECRET");
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLITE
// ─────────────────────────────────────────────────────────────────────────────

let db = null;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);

      const sql = `
        CREATE TABLE IF NOT EXISTS state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS processed (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shopify_order_gid TEXT NOT NULL,
          shopify_order_name TEXT,
          shipstation_order_id INTEGER,
          status TEXT NOT NULL DEFAULT 'tagged',
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(shopify_order_gid)
        );

        CREATE INDEX IF NOT EXISTS idx_processed_updated_at ON processed(updated_at);
      `;

      db.exec(sql, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function getState(key) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT value FROM state WHERE key = ?`, [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : null);
    });
  });
}

function setState(key, value) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO state(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `;
    db.run(sql, [key, value], (err) => (err ? reject(err) : resolve()));
  });
}

function wasProcessed(shopifyOrderGid) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM processed WHERE shopify_order_gid = ? LIMIT 1`,
      [shopifyOrderGid],
      (err, row) => (err ? reject(err) : resolve(!!row))
    );
  });
}

function markProcessed({ shopifyOrderGid, shopifyOrderName, shipstationOrderId, status, note }) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO processed (shopify_order_gid, shopify_order_name, shipstation_order_id, status, note)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shopify_order_gid) DO UPDATE SET
        shopify_order_name = excluded.shopify_order_name,
        shipstation_order_id = excluded.shipstation_order_id,
        status = excluded.status,
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `;
    db.run(
      sql,
      [shopifyOrderGid, shopifyOrderName, shipstationOrderId || null, status, note || null],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getStats() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT status, COUNT(*) as count FROM processed GROUP BY status`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function getRecentProcessed(limit = 50) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM processed ORDER BY updated_at DESC LIMIT ?`, [limit], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY GRAPHQL (2024-10)
// ─────────────────────────────────────────────────────────────────────────────

function shopifyGraphQLClient() {
  return axios.create({
    baseURL: `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

/**
 * Fetch orders updated since `sinceISO` (inclusive) using Shopify order query.
 * Uses cursor pagination.
 */
async function fetchShopifyOrdersUpdatedSince(sinceISO) {
  const client = shopifyGraphQLClient();

  // Shopify order search query syntax: updated_at:>=YYYY-MM-DDTHH:MM:SSZ
  // We'll build: updated_at:>=<sinceISO> plus optional extra query.
  const queryParts = [`updated_at:>=${sinceISO}`];
  if (SHOPIFY_EXTRA_QUERY) queryParts.push(`(${SHOPIFY_EXTRA_QUERY})`);
  const query = queryParts.join(" AND ");

  const gql = `
    query OrdersUpdatedSince($first: Int!, $after: String, $query: String!) {
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: false) {
        edges {
          cursor
          node {
            id
            name
            updatedAt
            shippingAddress {
              validationResultSummary
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const results = [];
  let after = null;
  let page = 1;

  while (true) {
    const resp = await client.post("/graphql.json", {
      query: gql,
      variables: { first: 50, after, query },
    });

    if (resp.data?.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(resp.data.errors)}`);
    }

    const orders = resp.data?.data?.orders;
    const edges = orders?.edges || [];
    const pageInfo = orders?.pageInfo;

    if (DEBUG) {
      console.log(`📦 Shopify fetched: ${edges.length} orders (page ${page}) query="${query}"`);
    }

    for (const e of edges) results.push(e.node);

    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
    page += 1;
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIPSTATION API
// ─────────────────────────────────────────────────────────────────────────────

function shipStationClient() {
  return axios.create({
    baseURL: "https://ssapi.shipstation.com",
    auth: { username: SHIPSTATION_API_KEY, password: SHIPSTATION_API_SECRET },
    timeout: 15000,
  });
}

async function getTagId(tagName) {
  const client = shipStationClient();
  const res = await client.get("/accounts/listtags");
  const tags = res.data?.tags || res.data || [];
  const match = tags.find((t) => String(t.name || "").toLowerCase() === tagName.toLowerCase());
  return match ? match.tagId : null;
}

async function findShipStationOrder(orderNumber) {
  const client = shipStationClient();
  try {
    const res = await client.get("/orders", { params: { orderNumber } });
    const orders = res.data?.orders || [];
    return orders[0] || null;
  } catch (e) {
    console.log(`❌ ShipStation search error for ${orderNumber}: ${e.message}`);
    return null;
  }
}

async function addTagToShipStationOrder(orderId, tagId) {
  const client = shipStationClient();
  await client.post("/orders/addtag", { orderId, tagId });
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC
// ─────────────────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s ?? "").trim();
}

function isShopifyAddressIssue(order) {
  // Shopify returns validationResultSummary: NO_ISSUES | WARNING | ERROR | null
  const v = normalize(order?.shippingAddress?.validationResultSummary).toUpperCase();
  return v === "WARNING" || v === "ERROR";
}

function orderNumberFromShopifyName(name) {
  // Shopify order.name is like "#66053"
  return String(name || "").replace("#", "").trim();
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function pollOnce(tagId) {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`🔄 Poll started: ${new Date().toLocaleString()}`);
  console.log(`${"═".repeat(80)}`);

  // Determine "since" timestamp
  let since = await getState("last_shopify_poll_iso");
  if (!since) {
    since = isoMinutesAgo(LOOKBACK_MINUTES_ON_FIRST_RUN);
    if (DEBUG) console.log(`ℹ️ First run: using lookback ${LOOKBACK_MINUTES_ON_FIRST_RUN} minutes => since=${since}`);
  } else {
    if (DEBUG) console.log(`ℹ️ Using saved since=${since}`);
  }

  // Fetch Shopify orders updated since
  const orders = await fetchShopifyOrdersUpdatedSince(since);

  let inspected = 0;
  let addressIssues = 0;
  let newlyTagged = 0;
  let notInShipStation = 0;
  let skippedAlready = 0;
  let errors = 0;

  // We'll advance last poll time to "now" at end.
  const newSince = new Date().toISOString();

  for (const o of orders) {
    inspected += 1;

    const summary = normalize(o?.shippingAddress?.validationResultSummary);
    if (DEBUG && summary) {
      console.log(`🧾 Shopify order ${o.name} updatedAt=${o.updatedAt} validationResultSummary="${summary}"`);
    }

    if (!isShopifyAddressIssue(o)) continue;

    addressIssues += 1;

    const already = await wasProcessed(o.id);
    if (already) {
      skippedAlready += 1;
      continue;
    }

    const orderNumber = orderNumberFromShopifyName(o.name);
    if (!orderNumber) continue;

    try {
      console.log(`⚠️  Shopify address issue: ${o.name} (validation=${summary}) → tagging ShipStation orderNumber=${orderNumber}`);

      const ssOrder = await findShipStationOrder(orderNumber);
      if (!ssOrder) {
        notInShipStation += 1;
        await markProcessed({
          shopifyOrderGid: o.id,
          shopifyOrderName: o.name,
          shipstationOrderId: null,
          status: "not_found",
          note: "Not found in ShipStation yet",
        });
        console.log(`⏳ Not in ShipStation yet: ${o.name}`);
        continue;
      }

      await addTagToShipStationOrder(ssOrder.orderId, tagId);

      newlyTagged += 1;
      await markProcessed({
        shopifyOrderGid: o.id,
        shopifyOrderName: o.name,
        shipstationOrderId: ssOrder.orderId,
        status: "tagged",
        note: `Tagged ${ADDRESS_ISSUE_TAG_NAME} (Shopify validation=${summary})`,
      });

      console.log(`✅ Tagged ShipStation orderId=${ssOrder.orderId} for Shopify ${o.name}`);
    } catch (e) {
      errors += 1;
      const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      await markProcessed({
        shopifyOrderGid: o.id,
        shopifyOrderName: o.name,
        shipstationOrderId: null,
        status: "error",
        note: msg,
      });
      console.log(`❌ Error tagging for ${o.name}: ${msg}`);
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  // Save new poll time
  await setState("last_shopify_poll_iso", newSince);

  console.log(`\n📌 Poll summary:`);
  console.log(`   Shopify orders inspected: ${inspected}`);
  console.log(`   Shopify address issues:   ${addressIssues}`);
  console.log(`   Newly tagged in SS:       ${newlyTagged}`);
  console.log(`   Not found in SS yet:      ${notInShipStation}`);
  console.log(`   Skipped (already seen):   ${skippedAlready}`);
  console.log(`   Errors:                   ${errors}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS (optional dashboard)
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.get("/health", async (req, res) => {
  const last = await getState("last_shopify_poll_iso");
  res.json({
    status: "healthy",
    now: new Date().toISOString(),
    pollIntervalSeconds: Math.round(POLL_INTERVAL_MS / 1000),
    dbPath: DB_PATH,
    shop: SHOPIFY_SHOP_DOMAIN,
    lastShopifyPollISO: last,
    tagName: ADDRESS_ISSUE_TAG_NAME,
    debug: DEBUG,
  });
});

app.get("/", async (req, res) => {
  try {
    const stats = await getStats();
    const recent = await getRecentProcessed(50);
    const last = await getState("last_shopify_poll_iso");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Shopify → ShipStation Address Issue Tagger</title>
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
    .muted { color: #6b7280; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🏷️ Shopify → ShipStation Address Issue Tagger</h1>
  <p class="muted">Shop: <strong>${SHOPIFY_SHOP_DOMAIN}</strong> • Tag: <strong>${ADDRESS_ISSUE_TAG_NAME}</strong></p>
  <p class="muted">Poll every ${Math.round(POLL_INTERVAL_MS/1000)}s • DB: <code>${DB_PATH}</code></p>
  <p class="muted">Last poll ISO: <code>${last || "none yet"}</code></p>

  <div class="cards">
    ${(stats || []).map(s => `
      <div class="card">
        <div class="num">${s.count}</div>
        <div class="label">${String(s.status).toUpperCase()}</div>
      </div>
    `).join("")}
  </div>

  <h2>Recent Processed</h2>
  <table>
    <thead>
      <tr>
        <th>Shopify Order</th>
        <th>Status</th>
        <th>ShipStation Order ID</th>
        <th>Note</th>
        <th>Updated</th>
      </tr>
    </thead>
    <tbody>
      ${(recent || []).map(r => `
        <tr>
          <td><strong>${r.shopify_order_name || ""}</strong></td>
          <td>${r.status}</td>
          <td>${r.shipstation_order_id || ""}</td>
          <td class="muted">${(r.note || "").slice(0, 220)}</td>
          <td class="muted">${r.updated_at}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>
</body>
</html>`;

    res.send(html);
  } catch (e) {
    res.status(500).send("Dashboard error: " + e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  const missing = missingEnvVars();
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  await initDatabase();
  console.log(`✅ SQLite ready: ${DB_PATH}`);

  const tagId = await getTagId(ADDRESS_ISSUE_TAG_NAME);
  if (!tagId) {
    console.error(
      `❌ ShipStation tag "${ADDRESS_ISSUE_TAG_NAME}" not found.\n` +
      `   Create it in ShipStation first, then redeploy.`
    );
    process.exit(1);
  }
  console.log(`✅ ShipStation tag ready: "${ADDRESS_ISSUE_TAG_NAME}" (tagId=${tagId})`);

  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🩺 Health: /health`);
    console.log(`📊 Dashboard: /`);
  });

  // Run immediately, then on interval
  console.log(`🤖 Polling Shopify every ${Math.round(POLL_INTERVAL_MS / 1000)} seconds...`);
  await pollOnce(tagId);

  setInterval(() => {
    pollOnce(tagId).catch((e) => console.error("💥 Poll error:", e.message));
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

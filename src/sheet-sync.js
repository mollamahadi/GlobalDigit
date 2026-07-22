const fs = require("fs");
const { google } = require("googleapis");
const config = require("./config");
const db = require("./database");

const SHEETS = {
  user_upsert: {
    tab: "Users",
    headers: ["Telegram ID", "Username", "First Name", "Balance USD", "Status", "Terms Accepted", "Channel Verified", "Created At", "Updated At"],
    row: (p) => [p.telegram_id, p.username, p.first_name, p.balance, p.status, p.terms_accepted, p.channel_verified, p.created_at, p.updated_at]
  },
  product_upsert: {
    tab: "Products",
    headers: ["Product ID", "Category ID", "Category", "Product Name", "Price USD", "Product Type", "Area Codes", "Delivery Mode", "Status", "Created At", "Updated At"],
    row: (p) => [p.id, p.category_id, p.category, p.name, p.price, p.product_type, p.area_codes, p.delivery_mode, p.status, p.created_at, p.updated_at]
  },
  stock_upsert: {
    tab: "Stock",
    headers: ["Stock ID", "Product ID", "Product Name", "Area Code", "Account / Stock Details", "Status", "Sold To", "Sold At", "Created At"],
    row: (p) => [p.id, p.product_id, p.product_name, p.area_code, p.stock_data, p.status, p.sold_to, p.sold_at, p.created_at]
  },
  order_upsert: {
    tab: "Orders",
    headers: ["Order ID", "Telegram ID", "Username", "Product ID", "Product Name", "Area Code", "Quantity", "Unit Price USD", "Total Price USD", "Delivery Mode", "Status", "Purchased At", "Delivered At"],
    row: (p) => [p.id, p.telegram_id, p.username, p.product_id, p.product_name, p.area_code, p.quantity, p.unit_price, p.total_price, p.delivery_mode, p.status, p.created_at, p.delivered_at]
  },
  delivery_upsert: {
    tab: "Delivered",
    headers: ["Delivery ID", "Order ID", "Stock ID", "Telegram ID", "Username", "Product ID", "Product Name", "Area Code", "Delivered Account Details", "Delivery Mode", "Delivered At"],
    row: (p) => [p.id, p.order_id, p.stock_id, p.telegram_id, p.username, p.product_id, p.product_name, p.area_code, p.delivered_data, p.delivery_mode, p.delivered_at]
  },
  deposit_upsert: {
    tab: "Deposits",
    headers: ["Request ID", "Telegram ID", "Username", "Amount USD", "Payment Method", "TXID / Hash", "Screenshot File ID", "Status", "Created At", "Reviewed At"],
    row: (p) => [p.id, p.telegram_id, p.username, p.amount, p.method, p.txid, p.screenshot_file_id, p.status, p.created_at, p.reviewed_at]
  }
};

let sheets;
let timer;
let running = false;
let tabsReady = false;

function enabled() {
  return config.sheetSyncEnabled && Boolean(config.googleSheetId);
}

async function getClient() {
  if (sheets) return sheets;
  if (!fs.existsSync(config.googleServiceAccountFile)) {
    throw new Error(`Google service-account file not found: ${config.googleServiceAccountFile}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: config.googleServiceAccountFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  sheets = google.sheets({ version: "v4", auth });
  return sheets;
}

async function ensureTabs() {
  if (!enabled()) return;
  const api = await getClient();
  const spreadsheet = await api.spreadsheets.get({ spreadsheetId: config.googleSheetId });
  const existing = new Set((spreadsheet.data.sheets || []).map((s) => s.properties.title));
  const required = [...new Set(Object.values(SHEETS).map((s) => s.tab))];
  const missing = required.filter((title) => !existing.has(title));
  if (missing.length) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: config.googleSheetId,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }
    });
  }
  for (const schema of Object.values(SHEETS)) {
    const current = await api.spreadsheets.values.get({
      spreadsheetId: config.googleSheetId,
      range: `'${schema.tab}'!A1:Z1`
    });
    if (!(current.data.values || []).length) {
      await api.spreadsheets.values.update({
        spreadsheetId: config.googleSheetId,
        range: `'${schema.tab}'!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [schema.headers] }
      });
    }
  }
}

async function upsertRow(schema, entityKey, payload) {
  const api = await getClient();
  const keys = await api.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: `'${schema.tab}'!A2:A`
  });
  const values = keys.data.values || [];
  const index = values.findIndex((row) => String(row[0]) === String(entityKey));
  const row = schema.row(payload).map((value) => value ?? "");
  if (index >= 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: config.googleSheetId,
      range: `'${schema.tab}'!A${index + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `'${schema.tab}'!A:Z`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
  }
}

async function claimEvent() {
  const result = await db.query(`
    WITH next_event AS (
      SELECT id FROM sheet_outbox
      WHERE status='pending' AND next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE sheet_outbox o
    SET status='processing', attempts=attempts+1
    FROM next_event
    WHERE o.id=next_event.id
    RETURNING o.*
  `);
  return result.rows[0];
}

async function processQueue() {
  if (!enabled() || running) return;
  running = true;
  try {
    for (let count = 0; count < 25; count += 1) {
      const event = await claimEvent();
      if (!event) break;
      try {
        const schema = SHEETS[event.event_type];
        if (!schema) throw new Error(`Unknown sheet event: ${event.event_type}`);
        await upsertRow(schema, event.entity_key, event.payload);
        await db.query("UPDATE sheet_outbox SET status='completed',completed_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?", [event.id]);
      } catch (error) {
        const delaySeconds = Math.min(900, Math.max(10, 2 ** Math.min(event.attempts, 9)));
        await db.query(
          "UPDATE sheet_outbox SET status='pending',next_attempt_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),last_error=? WHERE id=?",
          [delaySeconds, String(error.message).slice(0, 1000), event.id]
        );
        console.error(`Google Sheet sync failed for event ${event.id}:`, error.message);
      }
    }
  } finally {
    running = false;
  }
}

async function queueFullSync() {
  if (!enabled()) throw new Error("Google Sheet sync is disabled or GOOGLE_SHEET_ID is missing");
  const groups = [
    ["user_upsert", "telegram_id", await db.prepare("SELECT * FROM users ORDER BY created_at").all()],
    ["product_upsert", "id", await db.prepare("SELECT p.*,c.name category FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.id").all()],
    ["stock_upsert", "id", await db.prepare("SELECT s.*,p.name product_name FROM stocks s JOIN products p ON p.id=s.product_id ORDER BY s.id").all()],
    ["order_upsert", "id", await db.prepare("SELECT o.*,u.username FROM orders o JOIN users u ON u.telegram_id=o.telegram_id ORDER BY o.id").all()],
    ["delivery_upsert", "id", await db.prepare("SELECT d.*,u.username FROM deliveries d JOIN users u ON u.telegram_id=d.telegram_id ORDER BY d.id").all()],
    ["deposit_upsert", "id", await db.prepare("SELECT f.*,u.username FROM fund_requests f JOIN users u ON u.telegram_id=f.telegram_id ORDER BY f.id").all()]
  ];
  let count = 0;
  await db.transaction(async () => {
    for (const [eventType, key, rows] of groups) {
      for (const row of rows) {
        await db.enqueueSheetEvent(eventType, row[key], row);
        count += 1;
      }
    }
  })();
  return count;
}

async function startSheetWorker() {
  if (!enabled()) {
    console.log("Google Sheet sync is disabled. PostgreSQL remains active.");
    return;
  }
  await db.query("UPDATE sheet_outbox SET status='pending' WHERE status='processing'");
  const cycle = async () => {
    try {
      if (!tabsReady) {
        await ensureTabs();
        tabsReady = true;
        console.log("Google Sheet tabs are ready.");
      }
      await processQueue();
    } catch (error) {
      tabsReady = false;
      console.error("Google Sheet worker will retry:", error.message);
    }
  };
  await cycle();
  timer = setInterval(cycle, 10000);
  timer.unref();
  console.log("Google Sheet sync worker is active.");
}

function stopSheetWorker() {
  if (timer) clearInterval(timer);
}

module.exports = { startSheetWorker, stopSheetWorker, processQueue, ensureTabs, queueFullSync };

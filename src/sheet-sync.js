const config = require("./config");
const db = require("./database");

const EVENT_TYPES = new Set([
  "user_upsert",
  "product_upsert",
  "stock_upsert",
  "order_upsert",
  "delivery_upsert",
  "deposit_upsert"
]);

let timer;
let running = false;
let appsScriptReady = false;

function enabled() {
  return config.sheetSyncEnabled && Boolean(config.googleAppsScriptUrl) && Boolean(config.googleAppsScriptSecret);
}

async function callAppsScript(body) {
  const response = await fetch(config.googleAppsScriptUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: config.googleAppsScriptSecret, ...body }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned a non-JSON response (${response.status}). Check Web App access and URL.`);
  }
  if (!response.ok || !result.ok) throw new Error(result.error || `Apps Script HTTP ${response.status}`);
  return result;
}

async function ensureTabs() {
  if (!enabled()) return;
  await callAppsScript({ action: "setup" });
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
        if (!EVENT_TYPES.has(event.event_type)) throw new Error(`Unknown sheet event: ${event.event_type}`);
        await callAppsScript({
          action: "upsert",
          eventType: event.event_type,
          entityKey: event.entity_key,
          payload: event.payload
        });
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
  if (!enabled()) throw new Error("Apps Script Sheet sync is disabled or its URL/secret is missing");
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
    console.log("Apps Script Sheet sync is disabled. PostgreSQL remains active.");
    return;
  }
  await db.query("UPDATE sheet_outbox SET status='pending' WHERE status='processing'");
  const cycle = async () => {
    try {
      if (!appsScriptReady) {
        await ensureTabs();
        appsScriptReady = true;
        console.log("Apps Script and Google Sheet tabs are ready.");
      }
      await processQueue();
    } catch (error) {
      appsScriptReady = false;
      console.error("Apps Script Sheet worker will retry:", error.message);
    }
  };
  await cycle();
  timer = setInterval(cycle, 10000);
  timer.unref();
  console.log("Apps Script Sheet sync worker is active.");
}

function stopSheetWorker() {
  if (timer) clearInterval(timer);
}

module.exports = { startSheetWorker, stopSheetWorker, processQueue, ensureTabs, queueFullSync };

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

/* =====================
   CONFIG
===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_PASSWORD = String(process.env.BOT_PASSWORD || "3322");
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8090/api";

const BRANCH = "PITSA";
const BRANCH_LABEL = "PITSA";

/* =====================
   INIT
===================== */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const API = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
});

/* =====================
   AUTH + STATE
===================== */
const authState = new Map();
const chatState = new Map();

/* =====================
   DATE UTILS
===================== */
function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(x.getDate()).padStart(2, "0")}`;
}
const today = () => ymd(new Date());
const addDays = (s, n) => {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return ymd(dt);
};
const isYMD = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/* =====================
   STATE
===================== */
function setDefault(chatId) {
  const t = today();
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      from: t,
      to: t,
      mode: "day",
      products: { category: null, page: 1, limit: 1000 },
    });
  }
}
function st(chatId) {
  setDefault(chatId);
  return chatState.get(chatId);
}
function setRange(chatId, from, to, mode) {
  const s = st(chatId);
  s.from = from;
  s.to = to;
  s.mode = mode;
  s.products.page = 1;
}
const rangeText = (s) => (s.from === s.to ? s.from : `${s.from} → ${s.to}`);

/* =====================
   FORMAT
===================== */
const money = (n) =>
  Math.round(Number(n || 0))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/* =====================
   UI
===================== */
function mainMenu(chatId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `📅 Sana: ${rangeText(st(chatId))}`, callback_data: "DATE" }],
        [
          { text: "📊 Hisobot", callback_data: "SUMMARY" },
          { text: "👨‍🍳 Ofitsiantlar", callback_data: "WAITERS" },
        ],
        [
          { text: "🍕 Top taomlar", callback_data: "TOP_PRODUCTS" },
          { text: "📦 Mahsulotlar", callback_data: "PRODUCTS" },
        ],
      ],
    },
  };
}

function dateMenu() {
  const t = today();
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Bugun", callback_data: `SET:${t}:${t}` },
          {
            text: "Kecha",
            callback_data: `SET:${addDays(t, -1)}:${addDays(t, -1)}`,
          },
        ],
        [
          { text: "7 kun", callback_data: `SET:${addDays(t, -6)}:${t}` },
          { text: "30 kun", callback_data: `SET:${addDays(t, -29)}:${t}` },
        ],
        [{ text: "⬅️ Orqaga", callback_data: "BACK" }],
      ],
    },
  };
}

/* =====================
   API
===================== */
async function api(url, params) {
  const r = await API.get(url, {
    params: { branch: BRANCH, ...params },
  });
  return r.data;
}

/* =====================
   COMMANDS
===================== */
bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
  authState.set(chatId, false);
  setDefault(chatId);
  bot.sendMessage(chatId, "🔐 Parolni kiriting:");
});

bot.onText(/^\/logout$/, (msg) => {
  authState.set(msg.chat.id, false);
  bot.sendMessage(msg.chat.id, "🔒 Chiqildi. Parolni qayta kiriting:");
});

/* =====================
   CALLBACKS
===================== */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (!authState.get(chatId)) {
    return bot.sendMessage(chatId, "🔐 Avval parol kiriting");
  }

  if (data === "BACK") {
    return bot.sendMessage(chatId, "Asosiy menyu:", mainMenu(chatId));
  }

  if (data === "DATE") {
    return bot.sendMessage(chatId, "📅 Sana:", dateMenu());
  }

  if (data.startsWith("SET:")) {
    const [, from, to] = data.split(":");
    setRange(chatId, from, to, from === to ? "day" : "range");
    return bot.sendMessage(chatId, "✅ Sana tanlandi", mainMenu(chatId));
  }

  /* ===== SUMMARY (FOYDA QO‘SHILDI) ===== */
  if (data === "SUMMARY") {
    const s = st(chatId);
    const d = (await api("/reports/summary", s)).data;

   return bot.sendMessage(
     chatId,
     `📊 HISOBOT (${BRANCH_LABEL})\n` +
       `📅 ${rangeText(s)}\n\n` +
       `🧾 Buyurtmalar: ${d.ordersCount}\n` +
       `💰 Umumiy tushum: ${money(d.revenueTotal)} so'm\n\n` +
       `💵 Naqd: ${money(d.payments?.cash || 0)} so'm\n` +
       `💳 Karta: ${money(d.payments?.card || 0)} so'm\n` +
       `📲 Click: ${money(d.payments?.click || 0)} so'm\n\n` +
       `📈 Sof foyda: ${money(d.profitTotal || 0)} so'm`,
     mainMenu(chatId)
   );
  }

  /* ===== WAITERS ===== */
  if (data === "WAITERS") {
    const s = st(chatId);
    const rows = (await api("/reports/waiters", s)).data || [];

    if (!rows.length)
      return bot.sendMessage(chatId, "Ma’lumot yo‘q", mainMenu(chatId));

    return bot.sendMessage(
      chatId,
      `👨‍🍳 Ofitsiantlar\n📅 ${rangeText(s)}\n\n` +
        rows
          .map(
            (w, i) =>
              `${i + 1}) ${w.waiter_name}\n` +
              `   🧾 ${w.ordersCount} | 💰 ${money(w.revenueTotal)}\n` +
              `   💵 Oylik: ${money(w.totalSalary)}`
          )
          .join("\n\n"),
      mainMenu(chatId)
    );
  }

  /* ===== TOP PRODUCTS ===== */
  if (data === "TOP_PRODUCTS") {
    const s = st(chatId);
    const rows = (await api("/reports/top-products", s)).data || [];

    if (!rows.length)
      return bot.sendMessage(chatId, "Top mahsulotlar yo‘q", mainMenu(chatId));

    return bot.sendMessage(
      chatId,
      `🍕 Top mahsulotlar\n📅 ${rangeText(s)}\n\n` +
        rows
          .map(
            (p, i) =>
              `${i + 1}) ${p.name}\n` +
              `   📦 ${p.totalQty} | 💰 ${money(p.revenueTotal)}`
          )
          .join("\n"),
      mainMenu(chatId)
    );
  }

  /* ===== PRODUCTS ===== */
  if (data === "PRODUCTS") {
    const s = st(chatId);
    const r = await api("/reports/products", {
      ...s,
      page: s.products.page,
      limit: s.products.limit,
    });

    const items = r.data || [];
    if (!items.length)
      return bot.sendMessage(chatId, "Mahsulotlar yo‘q", mainMenu(chatId));

    return bot.sendMessage(
      chatId,
      `📦 Mahsulotlar\n📅 ${rangeText(s)}\n\n` +
        items
          .map(
            (x, i) =>
              `${i + 1}) ${x.name}\n` +
              `   📦 ${x.totalQty} | 💰 ${money(x.revenueTotal)}`
          )
          .join("\n"),
      mainMenu(chatId)
    );
  }
});

/* =====================
   TEXT INPUT
===================== */
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  if (text.startsWith("/")) return;

  if (!authState.get(chatId)) {
    if (text === BOT_PASSWORD) {
      authState.set(chatId, true);
      return bot.sendMessage(
        chatId,
        `✅ Kirish muvaffaqiyatli\n🏢 ${BRANCH_LABEL}\n📅 ${rangeText(
          st(chatId)
        )}`,
        mainMenu(chatId)
      );
    }
    return bot.sendMessage(chatId, "❌ Parol noto‘g‘ri");
  }

  if (isYMD(text)) {
    setRange(chatId, text, text, "day");
    return bot.sendMessage(chatId, "✅ Sana tanlandi", mainMenu(chatId));
  }

  const p = text.split(" ");
  if (p.length === 2 && isYMD(p[0]) && isYMD(p[1])) {
    setRange(chatId, p[0], p[1], "range");
    return bot.sendMessage(chatId, "✅ Sana tanlandi", mainMenu(chatId));
  }
});

console.log("🤖 BOT RUNNING (GLOBAL ORDERS)");

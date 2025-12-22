require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API = axios.create({
  baseURL: process.env.API_BASE_URL || "http://localhost:8072/api",
  timeout: 20000,
});

// =====================
// AUTH (PASSWORD GATE)
// =====================
const BOT_PASSWORD = String(process.env.BOT_PASSWORD || "3322");
const authState = new Map(); // chatId -> { authorized: true/false }

function isAuthorized(chatId) {
  return authState.get(chatId)?.authorized === true;
}

// =====================
// BRANCH LABELS (UI)
// =====================
const BRANCH_LABELS = {
  branch1: "NAVOIY",
  branch2: "DOSTLIK",
  branch3: "TORQOR",
};
function branchLabel(branchKey) {
  return BRANCH_LABELS[branchKey] || branchKey;
}

// =====================
// EXCLUDED WAITERS (Saboy etc.)
// =====================
const EXCLUDED_WAITER_NAMES = String(
  process.env.EXCLUDED_WAITER_NAMES || "Saboy"
)
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

function isExcludedWaiter(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  if (!n) return false;
  return EXCLUDED_WAITER_NAMES.includes(n);
}

// 10% pool -> 7% real salary (70% of 10%)
function toRealSalary7(salary10) {
  return Number(salary10 || 0) * 0.7;
}

// =====================
// CHAT STATE
// =====================
const chatState = new Map(); // chatId -> { branch, from, to, mode, products:{category,page,limit} }

function ymd(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(ymdStr, deltaDays) {
  const [Y, M, D] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return ymd(dt);
}

function todayYMD() {
  return ymd(new Date());
}

function setDefaultState(chatId) {
  const t = todayYMD();
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      branch: "branch1",
      from: t,
      to: t,
      mode: "day",
      products: { category: null, page: 1, limit: 10 },
    });
    return;
  }
  const st = chatState.get(chatId) || {};
  if (!st.branch) st.branch = "branch1";
  if (!st.from) st.from = t;
  if (!st.to) st.to = t;
  if (!st.mode) st.mode = "day";
  if (!st.products) st.products = { category: null, page: 1, limit: 10 };
  if (typeof st.products.page !== "number") st.products.page = 1;
  if (typeof st.products.limit !== "number") st.products.limit = 10;
  chatState.set(chatId, st);
}

function getState(chatId) {
  setDefaultState(chatId);
  return chatState.get(chatId);
}

function setRange(chatId, from, to, mode = "range") {
  const st = getState(chatId);
  st.from = from;
  st.to = to;
  st.mode = mode;
  st.products.page = 1;
  chatState.set(chatId, st);
}

function formatMoney(n) {
  const x = Math.round(Number(n || 0));
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function formatRange(st) {
  if (st.from === st.to) return st.from;
  return `${st.from} → ${st.to}`;
}

// =====================
// UI
// =====================
function mainMenu(chatId) {
  const st = getState(chatId);
  const rangeText = formatRange(st);

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `🏢 Filial: ${branchLabel(st.branch)}`,
            callback_data: "BRANCH_MENU",
          },
        ],
        [{ text: `📅 Sana: ${rangeText}`, callback_data: "DATE_MENU" }],
        [
          { text: "📊 Hisobot", callback_data: "SUMMARY" },
          { text: "👨‍🍳 Ofitsiantlar", callback_data: "WAITERS" },
        ],
        [
          { text: "🍽 Top taomlar", callback_data: "TOP_PRODUCTS" },
          { text: "📦 Mahsulotlar", callback_data: "PRODUCTS_MENU" },
        ],
      ],
    },
  };
}

function branchMenu(chatId) {
  const st = getState(chatId);
  const cur = st.branch;
  const mark = (k, label) => (cur === k ? `✅ ${label}` : label);

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: mark("branch1", "NAVOIY"),
            callback_data: "SET_BRANCH:branch1",
          },
        ],
        [
          {
            text: mark("branch2", "DOSTLIK"),
            callback_data: "SET_BRANCH:branch2",
          },
        ],
        [
          {
            text: mark("branch3", "TORQOR"),
            callback_data: "SET_BRANCH:branch3",
          },
        ],
        [{ text: "⬅️ Orqaga", callback_data: "BACK_MAIN" }],
      ],
    },
  };
}

function dateMenu(chatId) {
  const t = todayYMD();

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🟦 Bugun", callback_data: `SET_RANGE:DAY:${t}:${t}` },
          {
            text: "🕘 Kecha",
            callback_data: `SET_RANGE:DAY:${addDays(t, -1)}:${addDays(t, -1)}`,
          },
        ],
        [
          {
            text: "7 kun",
            callback_data: `SET_RANGE:RANGE:${addDays(t, -6)}:${t}`,
          },
          {
            text: "15 kun",
            callback_data: `SET_RANGE:RANGE:${addDays(t, -14)}:${t}`,
          },
          {
            text: "30 kun",
            callback_data: `SET_RANGE:RANGE:${addDays(t, -29)}:${t}`,
          },
        ],
        [
          {
            text: "Yillik",
            callback_data: `SET_RANGE:YEAR:${t.slice(0, 4)}-01-01:${t.slice(
              0,
              4
            )}-12-31`,
          },
        ],
        [{ text: "✍️ Sana yuborish", callback_data: "DATE_HELP" }],
        [{ text: "⬅️ Orqaga", callback_data: "BACK_MAIN" }],
      ],
    },
  };
}

function productsMenu(chatId) {
  const st = getState(chatId);
  const cat = st.products.category ? st.products.category : "Barchasi";

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🏷 Category: ${cat}`, callback_data: "CATEGORIES" }],
        [
          { text: "📄 Ro'yxat (page)", callback_data: "PRODUCTS_PAGE" },
          { text: "🔝 Top 10", callback_data: "PRODUCTS_TOP10" },
        ],
        [{ text: "⬅️ Orqaga", callback_data: "BACK_MAIN" }],
      ],
    },
  };
}

function productsPager(chatId, meta) {
  const st = getState(chatId);
  const page = meta?.page ?? st.products.page;
  const pages = meta?.pages ?? 1;

  const prevDisabled = page <= 1;
  const nextDisabled = page >= pages;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: prevDisabled ? "⬅️" : "⬅️ Oldingi",
            callback_data: prevDisabled ? "NOOP" : "PRODUCTS_PREV",
          },
          { text: `📄 ${page}/${pages}`, callback_data: "NOOP" },
          {
            text: nextDisabled ? "➡️" : "Keyingi ➡️",
            callback_data: nextDisabled ? "NOOP" : "PRODUCTS_NEXT",
          },
        ],
        [{ text: "🏷 Category tanlash", callback_data: "CATEGORIES" }],
        [{ text: "⬅️ Orqaga", callback_data: "PRODUCTS_MENU" }],
      ],
    },
  };
}

// =====================
// API wrappers
// =====================
async function apiSummary(branch, from, to) {
  const res = await API.get("/reports/summary", {
    params: { branch, from, to },
  });
  return res.data?.data;
}

async function apiWaiters(branch, from, to, page = 1, limit = 10) {
  const res = await API.get("/reports/waiters", {
    params: { branch, from, to, page, limit },
  });
  return res.data;
}

async function apiTopProducts(branch, from, to, limit = 10, category = null) {
  const params = { branch, from, to, limit };
  if (category) params.category = category;
  const res = await API.get("/reports/top-products", { params });
  return res.data;
}

async function apiCategories(branch, from, to) {
  const res = await API.get("/reports/categories", {
    params: { branch, from, to },
  });
  return res.data;
}

async function apiProducts(branch, from, to, page, limit, category = null) {
  const params = { branch, from, to, page, limit };
  if (category) params.category = category;
  const res = await API.get("/reports/products", { params });
  return res.data;
}

// ✅ NEW: waiters pool hisoblash (Saboyni chiqarib tashlab)
// Barcha pagesni olib kelib jamlaydi
async function calcWaitersPool(branch, from, to) {
  let page = 1;
  const limit = 100;
  let pages = 1;
  let pool10 = 0;

  while (page <= pages) {
    const res = await apiWaiters(branch, from, to, page, limit);
    const rows = res?.data || [];
    const meta = res?.meta || {};
    pages = Number(meta.pages || 1);

    for (const w of rows) {
      if (isExcludedWaiter(w.waiter_name)) continue;
      pool10 += Number(w.salaryTotal || 0); // bu 10% pool (backend hisoblagan)
    }

    page++;
  }

  return { pool10, salary7: toRealSalary7(pool10) };
}

// =====================
// COMMANDS
// =====================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  authState.set(chatId, { authorized: false });
  setDefaultState(chatId);
  return bot.sendMessage(chatId, "🔐 Botga kirish uchun parolni yuboring:");
});

bot.onText(/^\/logout$/, async (msg) => {
  const chatId = msg.chat.id;
  authState.set(chatId, { authorized: false });
  return bot.sendMessage(
    chatId,
    "🔒 Siz tizimdan chiqdingiz. Parolni qayta yuboring:"
  );
});

// =====================
// CALLBACKS
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  try {
    if (!isAuthorized(chatId)) {
      await bot.answerCallbackQuery(q.id, { text: "Avval parol kiriting" });
      return bot.sendMessage(
        chatId,
        "🔐 Avval parolni kiriting. /start bosing."
      );
    }

    if (data === "NOOP") return bot.answerCallbackQuery(q.id);

    if (data === "BACK_MAIN") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "Asosiy menyu:", mainMenu(chatId));
    }

    if (data === "BRANCH_MENU") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "Filialni tanlang:", branchMenu(chatId));
    }

    if (data.startsWith("SET_BRANCH:")) {
      const branch = data.split(":")[1];
      const st = getState(chatId);
      st.branch = branch;
      chatState.set(chatId, st);
      await bot.answerCallbackQuery(q.id, {
        text: `Filial: ${branchLabel(branch)}`,
      });
      return bot.sendMessage(
        chatId,
        `✅ Filial o‘zgardi: ${branchLabel(branch)}`,
        mainMenu(chatId)
      );
    }

    if (data === "DATE_MENU") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "📅 Tez filtrlar:", dateMenu(chatId));
    }

    if (data === "DATE_HELP") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        `✍️ Sana yuborish:\n` +
          `1) Bitta kun: 2025-09-26\n` +
          `2) Oraliq: 2025-09-01 2025-09-30\n\n` +
          `Format: YYYY-MM-DD`
      );
    }

    if (data.startsWith("SET_RANGE:")) {
      const parts = data.split(":");
      const type = parts[1];
      const from = parts[2];
      const to = parts[3];

      setRange(
        chatId,
        from,
        to,
        type === "YEAR" ? "year" : type === "DAY" ? "day" : "range"
      );

      await bot.answerCallbackQuery(q.id, {
        text: `Sana: ${from === to ? from : `${from}→${to}`}`,
      });
      return bot.sendMessage(
        chatId,
        `✅ Sana tanlandi: ${from === to ? from : `${from} → ${to}`}`,
        mainMenu(chatId)
      );
    }

    // =====================
    // ✅ SUMMARY (Oylik 7% - waiters dan hisoblab)
    // =====================
    if (data === "SUMMARY") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const d = await apiSummary(st.branch, st.from, st.to);

      // ✅ 10% pool (Saboysiz) va 7% real salary
      const { pool10, salary7 } = await calcWaitersPool(
        st.branch,
        st.from,
        st.to
      );

      const text =
        `📊 Hisobot\n` +
        `🏢 Filial: ${branchLabel(st.branch)}\n` +
        `📅 Sana: ${formatRange(st)}\n\n` +
        `🧾 Buyurtmalar: ${d.ordersCount}\n` +
        `💰 Tushum: ${formatMoney(d.revenueTotal)}\n` +
        `🧾 O'rtacha chek: ${formatMoney(d.avgCheck)}\n\n` +
        `👨‍🍳 Ofitsiant pool (10%): ${formatMoney(pool10)}\n` +
        `👨‍🍳 Haqiqiy oylik (7%): ${formatMoney(salary7)}\n\n` +
        `💵 Naqd: ${formatMoney(d.payments.cash)}\n` +
        `💳 Karta: ${formatMoney(d.payments.card)}\n` +
        `📲 Click: ${formatMoney(d.payments.click)}`;

      return bot.sendMessage(chatId, text, mainMenu(chatId));
    }

    // =====================
    // ✅ WAITERS (7% ko‘rsatamiz, Saboyni chiqaramiz)
    // =====================
    if (data === "WAITERS") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const res = await apiWaiters(st.branch, st.from, st.to, 1, 50);
      let rows = res?.data || [];

      // Saboy (va excludedlar) ni chiqaramiz
      rows = rows.filter((w) => !isExcludedWaiter(w.waiter_name));

      if (!rows.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada ofitsiantlar bo‘yicha data yo‘q.",
          mainMenu(chatId)
        );
      }

      const text =
        `👨‍🍳 Ofitsiantlar (7%)\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n\n` +
        rows
          .map((w, i) => {
            const salary7 = toRealSalary7(w.salaryTotal || 0);
            return (
              `${i + 1}) ${w.waiter_name}\n` +
              `   🧾 ${w.ordersCount} ta | 💰 ${formatMoney(
                w.revenueTotal
              )} | 👨‍🍳 ${formatMoney(salary7)}`
            );
          })
          .join("\n");

      return bot.sendMessage(chatId, text, mainMenu(chatId));
    }

    // TOP PRODUCTS
    if (data === "TOP_PRODUCTS") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const res = await apiTopProducts(
        st.branch,
        st.from,
        st.to,
        10,
        st.products.category
      );
      const rows = res?.data || [];

      if (!rows.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada top taomlar data yo‘q.",
          mainMenu(chatId)
        );
      }

      const text =
        `🍽 Top taomlar (Top 10)\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n` +
        `🏷 ${
          st.products.category
            ? `Category: ${st.products.category}`
            : "Category: Barchasi"
        }\n\n` +
        rows
          .map(
            (p, i) =>
              `${i + 1}) ${p.name} (${p.category_name || "-"})\n` +
              `   📦 ${p.totalQty} | 💰 ${formatMoney(p.revenueTotal)}`
          )
          .join("\n");

      return bot.sendMessage(chatId, text, mainMenu(chatId));
    }

    // PRODUCTS MENU
    if (data === "PRODUCTS_MENU") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        "📦 Mahsulotlar menyusi:",
        productsMenu(chatId)
      );
    }

    // CATEGORIES (buttons)
    if (data === "CATEGORIES") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const catsRes = await apiCategories(st.branch, st.from, st.to);
      const cats = catsRes?.data || [];

      const rows = [];
      rows.push([
        {
          text: st.products.category ? "Barchasi" : "✅ Barchasi",
          callback_data: "SET_CATEGORY:__ALL__",
        },
      ]);

      for (let i = 0; i < cats.length; i += 2) {
        const a = cats[i];
        const b = cats[i + 1];

        const row = [
          {
            text: st.products.category === a ? `✅ ${a}` : a,
            callback_data: `SET_CATEGORY:${a}`,
          },
        ];

        if (b) {
          row.push({
            text: st.products.category === b ? `✅ ${b}` : b,
            callback_data: `SET_CATEGORY:${b}`,
          });
        }

        rows.push(row);
      }

      rows.push([{ text: "⬅️ Orqaga", callback_data: "PRODUCTS_MENU" }]);

      return bot.sendMessage(chatId, "🏷 Category tanlang:", {
        reply_markup: { inline_keyboard: rows },
      });
    }

    if (data.startsWith("SET_CATEGORY:")) {
      const st = getState(chatId);
      const cat = data.split(":").slice(1).join(":");
      st.products.category = cat === "__ALL__" ? null : cat;
      st.products.page = 1;
      chatState.set(chatId, st);

      await bot.answerCallbackQuery(q.id, {
        text: `Category: ${st.products.category || "Barchasi"}`,
      });
      return bot.sendMessage(
        chatId,
        `✅ Category tanlandi: ${st.products.category || "Barchasi"}`,
        productsMenu(chatId)
      );
    }

    // PRODUCTS PAGE (list)
    if (data === "PRODUCTS_PAGE") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const page = st.products.page || 1;
      const limit = st.products.limit || 10;

      const res = await apiProducts(
        st.branch,
        st.from,
        st.to,
        page,
        limit,
        st.products.category
      );
      const items = res?.data || [];
      const meta = res?.meta || { page, pages: 1, total: items.length, limit };

      if (!items.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada mahsulotlar bo‘yicha data yo‘q.",
          productsMenu(chatId)
        );
      }

      const head =
        `📦 Mahsulotlar\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n` +
        `🏷 ${
          st.products.category
            ? `Category: ${st.products.category}`
            : "Category: Barchasi"
        }\n\n`;

      const body = items
        .map(
          (x, i) =>
            `${(page - 1) * limit + (i + 1)}) ${x.name}\n` +
            `   📦 ${x.totalQty} | 💵 ${formatMoney(
              x.avgPrice
            )} | 💰 ${formatMoney(x.revenueTotal)} | 🧾 ${x.ordersCount}`
        )
        .join("\n");

      return bot.sendMessage(chatId, head + body, productsPager(chatId, meta));
    }

    if (data === "PRODUCTS_PREV") {
      const st = getState(chatId);
      st.products.page = Math.max((st.products.page || 1) - 1, 1);
      chatState.set(chatId, st);
      await bot.answerCallbackQuery(q.id);
      return bot
        .sendMessage(chatId, "⬅️ Oldingi sahifa:", {
          reply_markup: { inline_keyboard: [] },
        })
        .then(() =>
          bot.emit("callback_query", { ...q, data: "PRODUCTS_PAGE" })
        );
    }

    if (data === "PRODUCTS_NEXT") {
      const st = getState(chatId);
      st.products.page = (st.products.page || 1) + 1;
      chatState.set(chatId, st);
      await bot.answerCallbackQuery(q.id);
      return bot
        .sendMessage(chatId, "➡️ Keyingi sahifa:", {
          reply_markup: { inline_keyboard: [] },
        })
        .then(() =>
          bot.emit("callback_query", { ...q, data: "PRODUCTS_PAGE" })
        );
    }

    if (data === "PRODUCTS_TOP10") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const res = await apiProducts(
        st.branch,
        st.from,
        st.to,
        1,
        10,
        st.products.category
      );
      const items = res?.data || [];

      if (!items.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada mahsulotlar bo‘yicha data yo‘q.",
          productsMenu(chatId)
        );
      }

      const text =
        `📦 Mahsulotlar (Top 10)\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n` +
        `🏷 ${
          st.products.category
            ? `Category: ${st.products.category}`
            : "Category: Barchasi"
        }\n\n` +
        items
          .map(
            (x, i) =>
              `${i + 1}) ${x.name}\n` +
              `   📦 ${x.totalQty} | 💵 ${formatMoney(
                x.avgPrice
              )} | 💰 ${formatMoney(x.revenueTotal)} | 🧾 ${x.ordersCount}`
          )
          .join("\n");

      return bot.sendMessage(chatId, text, productsMenu(chatId));
    }

    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    try {
      await bot.answerCallbackQuery(q.id, { text: "Xatolik" });
    } catch (_) {}

    const msgText =
      "❌ Xatolik yuz berdi.\n" +
      (err.response?.data?.message
        ? `message: ${err.response.data.message}\n`
        : "") +
      (err.message ? `error: ${err.message}` : "");

    return bot.sendMessage(chatId, msgText);
  }
});

// =====================
// MESSAGE (PASSWORD + DATE/RANGE)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  if (text.startsWith("/")) return;

  setDefaultState(chatId);

  if (!isAuthorized(chatId)) {
    if (text === BOT_PASSWORD) {
      authState.set(chatId, { authorized: true });
      const st = getState(chatId);

      return bot.sendMessage(
        chatId,
        `✅ Kirish muvaffaqiyatli!\n` +
          `🏢 Filial: ${branchLabel(st.branch)}\n` +
          `📅 Sana: ${formatRange(st)}\n\n` +
          `Menyudan foydalaning yoki sana yuboring.`,
        mainMenu(chatId)
      );
    }
    return bot.sendMessage(chatId, "❌ Parol noto‘g‘ri. Qayta urinib ko‘ring:");
  }

  if (isValidYMD(text)) {
    setRange(chatId, text, text, "day");
    return bot.sendMessage(
      chatId,
      `✅ Sana tanlandi: ${text}`,
      mainMenu(chatId)
    );
  }

  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && isValidYMD(parts[0]) && isValidYMD(parts[1])) {
    const from = parts[0];
    const to = parts[1];
    setRange(chatId, from, to, "range");
    return bot.sendMessage(
      chatId,
      `✅ Sana tanlandi: ${from} → ${to}`,
      mainMenu(chatId)
    );
  }

  return bot.sendMessage(
    chatId,
    "ℹ️ Buyruqlar:\n" +
      "- Bitta sana: 2025-09-26\n" +
      "- Oraliq: 2025-09-01 2025-09-30\n" +
      "Yoki menyudan foydalaning."
  );
});

console.log("🤖 Bot running (polling)...");

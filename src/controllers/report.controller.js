const { getBranchKeyFromReq, getConn } = require("../config/dbManager");
const getOrderModel = require("../models/Order");

// =====================
// Helpers
// =====================
function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

const SABOY_NAMES = [
  "saboy",
  "saboiy",
  "delivery",
  "dostavka",
  "takeaway",
  "samovyvoz",
];

// Normalize waiter_name (lower + trim)
const WAITER_NAME_NORM_EXPR = {
  $toLower: { $trim: { input: { $ifNull: ["$waiter_name", ""] } } },
};

const IS_SABOY_EXPR = { $in: [WAITER_NAME_NORM_EXPR, SABOY_NAMES] };

// waiter_percentage can be 0/7/10/... (default: 10 if null/undefined)
const WAITER_PERCENT_EXPR = { $ifNull: ["$waiter_percentage", 10] };

// Saboy => 0%, else given percent
const WAITER_PERCENT_EFFECTIVE_EXPR = {
  $cond: [IS_SABOY_EXPR, 0, WAITER_PERCENT_EXPR],
};

// ✅ Salary base: total_price (preferred)
// fallback: max(final_total - service_amount, 0)
const SALARY_BASE_EXPR = {
  $cond: [
    { $gt: [{ $ifNull: ["$total_price", 0] }, 0] },
    { $ifNull: ["$total_price", 0] },
    {
      $max: [
        {
          $subtract: [
            { $ifNull: ["$final_total", 0] },
            { $ifNull: ["$service_amount", 0] },
          ],
        },
        0,
      ],
    },
  ],
};

// ✅ Base salary per order: salaryBase * waiterPercentEffective / 100
const BASE_SALARY_EXPR = {
  $multiply: [
    SALARY_BASE_EXPR,
    { $divide: [WAITER_PERCENT_EFFECTIVE_EXPR, 100] },
  ],
};

// ✅ Bonus salary per order: salaryBase * 7%
// Saboy => 0
const BONUS_SALARY_EXPR = {
  $cond: [IS_SABOY_EXPR, 0, { $multiply: [SALARY_BASE_EXPR, 0.07] }],
};

// ✅ Total salary per order
const TOTAL_SALARY_EXPR = { $add: [BASE_SALARY_EXPR, BONUS_SALARY_EXPR] };

// =====================
// Payments normalize
// =====================
const PAYMENTS_UNIFIED_EXPR = {
  $cond: [
    {
      $and: [
        { $isArray: "$mixedPaymentDetails" },
        { $gt: [{ $size: "$mixedPaymentDetails" }, 0] },
      ],
    },
    "$mixedPaymentDetails",
    {
      $cond: [
        {
          $and: [
            { $ne: ["$mixedPaymentDetails", null] },
            { $eq: [{ $type: "$mixedPaymentDetails" }, "object"] },
          ],
        },
        [
          {
            method: "cash",
            amount: { $ifNull: ["$mixedPaymentDetails.cashAmount", 0] },
          },
          {
            method: "card",
            amount: { $ifNull: ["$mixedPaymentDetails.cardAmount", 0] },
          },
          {
            method: "click",
            amount: { $ifNull: ["$mixedPaymentDetails.clickAmount", 0] },
          },
        ],
        [
          {
            method: { $toLower: { $ifNull: ["$paymentMethod", "unknown"] } },
            amount: {
              $ifNull: ["$paymentAmount", { $ifNull: ["$final_total", 0] }],
            },
          },
        ],
      ],
    },
  ],
};

// =====================
// GET /reports/summary
// =====================
exports.getSummary = async (req, res) => {
  try {
    const branchKey = getBranchKeyFromReq(req);
    const conn = getConn(branchKey);

    if (!conn) {
      return res.status(400).json({
        ok: false,
        message: `DB connection not ready for branch: ${branchKey}`,
      });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    if (!isValidYMD(from) || !isValidYMD(to)) {
      return res.status(400).json({
        ok: false,
        message:
          "from/to format xato. Format: YYYY-MM-DD. Misol: from=2025-12-21&to=2025-12-21",
      });
    }

    const Order = getOrderModel(conn);

    const match = {
      status: "paid",
      order_date: { $gte: from, $lte: to },
    };

    const pipeline = [
      { $match: match },

      {
        $addFields: {
          waiterNameNorm: WAITER_NAME_NORM_EXPR,
          paymentsUnified: PAYMENTS_UNIFIED_EXPR,

          salaryBase: SALARY_BASE_EXPR,
          waiterPercentEffective: WAITER_PERCENT_EFFECTIVE_EXPR,

          baseSalaryCalc: BASE_SALARY_EXPR,
          bonusSalaryCalc: BONUS_SALARY_EXPR,
          totalWaiterSalaryCalc: TOTAL_SALARY_EXPR,
        },
      },

      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                ordersCount: { $sum: 1 },

                // tushum (hisobot uchun)
                revenueTotal: { $sum: { $ifNull: ["$final_total", 0] } },
                avgCheck: { $avg: { $ifNull: ["$final_total", 0] } },

                // ✅ oylik bazasi yig'indisi
                salaryBaseTotal: { $sum: "$salaryBase" },

                // ✅ oyliklar
                waitersBaseSalaryTotal: { $sum: "$baseSalaryCalc" },
                waitersBonusSalaryTotal: { $sum: "$bonusSalaryCalc" },
                waitersSalaryTotal: { $sum: "$totalWaiterSalaryCalc" },
              },
            },
            {
              $project: {
                _id: 0,
                ordersCount: 1,
                revenueTotal: 1,
                avgCheck: { $ifNull: ["$avgCheck", 0] },

                salaryBaseTotal: 1,
                waitersBaseSalaryTotal: 1,
                waitersBonusSalaryTotal: 1,
                waitersSalaryTotal: 1,
              },
            },
          ],

          payments: [
            { $unwind: "$paymentsUnified" },
            {
              $group: {
                _id: {
                  $toLower: { $ifNull: ["$paymentsUnified.method", "unknown"] },
                },
                total: { $sum: { $ifNull: ["$paymentsUnified.amount", 0] } },
              },
            },
            { $project: { _id: 0, method: "$_id", total: 1 } },
          ],
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);

    const summary = agg?.[0]?.summary?.[0] || {
      ordersCount: 0,
      revenueTotal: 0,
      avgCheck: 0,
      salaryBaseTotal: 0,
      waitersBaseSalaryTotal: 0,
      waitersBonusSalaryTotal: 0,
      waitersSalaryTotal: 0,
    };

    const paymentsArr = agg?.[0]?.payments || [];
    const payments = { cash: 0, card: 0, click: 0 };

    for (const p of paymentsArr) {
      const method = String(p.method || "").toLowerCase();
      const total = Number(p.total || 0);

      if (method === "cash") payments.cash += total;
      else if (method === "card") payments.card += total;
      else if (method === "click") payments.click += total;
    }

    return res.json({
      ok: true,
      data: {
        range: { from, to },
        branch: branchKey,
        ...summary,
        payments,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// =====================
// GET /reports/waiters
// =====================
exports.getWaitersReport = async (req, res) => {
  try {
    const branchKey = getBranchKeyFromReq(req);
    const conn = getConn(branchKey);

    if (!conn) {
      return res.status(400).json({
        ok: false,
        message: `DB connection not ready for branch: ${branchKey}`,
      });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    if (!isValidYMD(from) || !isValidYMD(to)) {
      return res.status(400).json({
        ok: false,
        message: "from/to format xato. Format: YYYY-MM-DD",
      });
    }

    const page = Number.isFinite(parseInt(req.query.page, 10))
      ? Math.max(parseInt(req.query.page, 10), 1)
      : 1;

    const limit = Number.isFinite(parseInt(req.query.limit, 10))
      ? Math.min(Math.max(parseInt(req.query.limit, 10), 1), 100)
      : 10;

    const skip = (page - 1) * limit;

    const Order = getOrderModel(conn);

    const match = {
      status: "paid",
      order_date: { $gte: from, $lte: to },
    };

    const pipeline = [
      { $match: match },

      {
        $addFields: {
          waiterNameNorm: WAITER_NAME_NORM_EXPR,
          isSaboy: IS_SABOY_EXPR,

          salaryBase: SALARY_BASE_EXPR,
          waiterPercentEffective: WAITER_PERCENT_EFFECTIVE_EXPR,

          baseSalaryCalc: BASE_SALARY_EXPR,
          bonusSalaryCalc: BONUS_SALARY_EXPR,
          totalSalaryCalc: TOTAL_SALARY_EXPR,
        },
      },

      {
        $group: {
          _id: { $ifNull: ["$waiter_name", "Noma'lum"] },
          ordersCount: { $sum: 1 },

          // tushum: final_total yig'indisi
          revenueTotal: { $sum: { $ifNull: ["$final_total", 0] } },

          // ✅ bazasi: total_price yig'indisi
          salaryBaseTotal: { $sum: "$salaryBase" },

          // ✅ oyliklar yig'indisi
          baseSalary: { $sum: "$baseSalaryCalc" },
          bonusSalary: { $sum: "$bonusSalaryCalc" },
          totalSalary: { $sum: "$totalSalaryCalc" },

          // saboy flag (agar aralashib ketsa ham)
          anySaboy: { $max: { $cond: ["$isSaboy", 1, 0] } },

          // foizlar: bir waiterda turli foizlar bo‘lishi mumkin
          percents: { $addToSet: "$waiterPercentEffective" },
        },
      },

      {
        $addFields: {
          basePercent: {
            $cond: [
              { $eq: [{ $size: "$percents" }, 1] },
              { $arrayElemAt: ["$percents", 0] },
              // aralash bo‘lsa 0 qaytaramiz (xohlasang "mixed" qilib beraman)
              0,
            ],
          },
        },
      },

      { $sort: { revenueTotal: -1 } },

      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);

    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;

    return res.json({
      ok: true,
      data: items.map((x) => ({
        waiter_name: x._id,
        ordersCount: x.ordersCount || 0,
        revenueTotal: x.revenueTotal || 0,

        // ✅ bot/web uchun
        salaryBaseTotal: Number(x.salaryBaseTotal || 0),

        basePercent: Number(x.basePercent ?? 0),
        baseSalary: Number(x.baseSalary || 0),

        bonusPercent: 7,
        bonusSalary: Number(x.bonusSalary || 0),

        totalSalary: Number(x.totalSalary || 0),

        isSaboy: Number(x.anySaboy || 0) === 1,
      })),
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// =====================
// GET /reports/products
// =====================
exports.getProductsReport = async (req, res) => {
  try {
    const branchKey = getBranchKeyFromReq(req);
    const conn = getConn(branchKey);

    if (!conn) {
      return res.status(400).json({
        ok: false,
        message: `DB connection not ready for branch: ${branchKey}`,
      });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    if (!isValidYMD(from) || !isValidYMD(to)) {
      return res.status(400).json({
        ok: false,
        message: "from/to format xato. Format: YYYY-MM-DD",
      });
    }

    const category = String(req.query.category || "").trim();

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "10", 10), 1),
      100
    );
    const skip = (page - 1) * limit;

    const Order = getOrderModel(conn);

    const match = {
      status: "paid",
      order_date: { $gte: from, $lte: to },
    };

    const pipeline = [
      { $match: match },
      { $unwind: "$items" },

      ...(category
        ? [
            {
              $match: {
                "items.category_name": {
                  $regex: `^${category}$`,
                  $options: "i",
                },
              },
            },
          ]
        : []),

      {
        $addFields: {
          itemRevenue: {
            $multiply: [
              { $ifNull: ["$items.price", 0] },
              { $ifNull: ["$items.quantity", 0] },
            ],
          },
        },
      },

      {
        $group: {
          _id: { name: "$items.name", category_name: "$items.category_name" },
          totalQty: { $sum: { $ifNull: ["$items.quantity", 0] } },
          avgPrice: { $avg: { $ifNull: ["$items.price", 0] } },
          revenueTotal: { $sum: "$itemRevenue" },
          ordersSet: { $addToSet: "$_id" },
        },
      },

      { $addFields: { ordersCount: { $size: "$ordersSet" } } },
      { $sort: { revenueTotal: -1 } },

      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);

    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;

    return res.json({
      ok: true,
      data: items.map((x) => ({
        name: x._id?.name || "Noma'lum",
        category_name: x._id?.category_name || null,
        totalQty: x.totalQty || 0,
        avgPrice: x.avgPrice || 0,
        revenueTotal: x.revenueTotal || 0,
        ordersCount: x.ordersCount || 0,
      })),
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
        category: category || null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "Server error",
      error: err.message,
    });
  }
};

exports.getTopProducts = async (req, res) => {
  try {
    const branchKey = getBranchKeyFromReq(req);
    const conn = getConn(branchKey);

    if (!conn) {
      return res.status(400).json({
        ok: false,
        message: `DB connection not ready for branch: ${branchKey}`,
      });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (!isValidYMD(from) || !isValidYMD(to)) {
      return res.status(400).json({
        ok: false,
        message: "from/to format xato. Format: YYYY-MM-DD",
      });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "10", 10), 1),
      50
    );
    const category = String(req.query.category || "").trim();

    const Order = getOrderModel(conn);

    const pipeline = [
      { $match: { status: "paid", order_date: { $gte: from, $lte: to } } },
      { $unwind: "$items" },

      ...(category
        ? [
            {
              $match: {
                "items.category_name": {
                  $regex: `^${category}$`,
                  $options: "i",
                },
              },
            },
          ]
        : []),

      {
        $addFields: {
          itemRevenue: {
            $multiply: [
              { $ifNull: ["$items.price", 0] },
              { $ifNull: ["$items.quantity", 0] },
            ],
          },
        },
      },

      {
        $group: {
          _id: { name: "$items.name", category_name: "$items.category_name" },
          totalQty: { $sum: { $ifNull: ["$items.quantity", 0] } },
          revenueTotal: { $sum: "$itemRevenue" },
        },
      },

      { $sort: { revenueTotal: -1 } },
      { $limit: limit },

      {
        $project: {
          _id: 0,
          name: "$_id.name",
          category_name: "$_id.category_name",
          totalQty: 1,
          revenueTotal: 1,
        },
      },
    ];

    const data = await Order.aggregate(pipeline);

    return res.json({
      ok: true,
      data,
      meta: { from, to, limit, category: category || null },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "Server error",
      error: err.message,
    });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const branchKey = getBranchKeyFromReq(req);
    const conn = getConn(branchKey);

    if (!conn) {
      return res.status(400).json({
        ok: false,
        message: `DB connection not ready for branch: ${branchKey}`,
      });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    if (!isValidYMD(from) || !isValidYMD(to)) {
      return res.status(400).json({
        ok: false,
        message: "from/to format xato. Format: YYYY-MM-DD",
      });
    }

    const Order = getOrderModel(conn);

    const pipeline = [
      { $match: { status: "paid", order_date: { $gte: from, $lte: to } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: { $toLower: { $ifNull: ["$items.category_name", "unknown"] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, category: "$_id" } },
    ];

    const rows = await Order.aggregate(pipeline);
    const categories = rows
      .map((r) => r.category)
      .filter((c) => c && c !== "unknown");

    return res.json({
      ok: true,
      data: categories,
      meta: { from, to, count: categories.length },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "Server error",
      error: err.message,
    });
  }
};

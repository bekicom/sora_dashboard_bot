const { getBranchKeyFromReq, getConn } = require("../config/dbManager");
const getOrderModel = require("../models/Order");

function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

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
        message: "from/to format xato. Format: YYYY-MM-DD",
      });
    }

    const Order = getOrderModel(conn);

    const pipeline = [
      { $match: { status: "paid", order_date: { $gte: from, $lte: to } } },

      {
        $addFields: {
          waiterNameLower: {
            $toLower: { $trim: { input: { $ifNull: ["$waiter_name", ""] } } },
          },

          // mixedPaymentDetails yo'q bo'lsa ham bitta default payment
          paymentsUnified: {
            $cond: [
              {
                $and: [
                  { $isArray: "$mixedPaymentDetails" },
                  { $gt: [{ $size: "$mixedPaymentDetails" }, 0] },
                ],
              },
              "$mixedPaymentDetails",
              [
                {
                  method: { $ifNull: ["$paymentMethod", "unknown"] },
                  amount: { $ifNull: ["$paymentAmount", 0] },
                },
              ],
            ],
          },

          // servicePercent:
          // - null/undefined bo'lsa => 10
          // - 0 bo'lsa => 0 (Saboy kabi)
          // - >0 bo'lsa o'sha
          servicePercent: {
            $cond: [
              { $eq: ["$waiter_percentage", null] },
              10,
              { $ifNull: ["$waiter_percentage", 10] },
            ],
          },
        },
      },

      // base/service/salary hisoblash
      {
        $addFields: {
          finalTotalCalc: { $ifNull: ["$final_total", 0] },

          // service_amount bo'lsa shuni ishlatamiz
          serviceAmountCalc: {
            $cond: [
              { $gt: [{ $ifNull: ["$service_amount", 0] }, 0] },
              { $ifNull: ["$service_amount", 0] },
              // service_amount yo'q bo'lsa, percent orqali hisoblaymiz:
              {
                $cond: [
                  { $gt: ["$servicePercent", 0] },
                  {
                    $subtract: [
                      { $ifNull: ["$final_total", 0] },
                      {
                        $divide: [
                          { $ifNull: ["$final_total", 0] },
                          { $add: [1, { $divide: ["$servicePercent", 100] }] },
                        ],
                      },
                    ],
                  },
                  0,
                ],
              },
            ],
          },
        },
      },

      {
        $addFields: {
          baseTotalCalc: {
            $cond: [
              { $gt: ["$serviceAmountCalc", 0] },
              { $subtract: ["$finalTotalCalc", "$serviceAmountCalc"] },
              // service bo'lmasa base=final
              "$finalTotalCalc",
            ],
          },

          // Oylik = base * 7%
          salary7Calc: {
            $cond: [
              // saboy bo'lsa 0
              { $eq: ["$waiterNameLower", "saboy"] },
              0,
              {
                $cond: [
                  { $gt: ["$servicePercent", 0] },
                  { $multiply: ["$baseTotalCalc", 0.07] },
                  0,
                ],
              },
            ],
          },

          // Asosiy = serviceAmount (10%)
          serviceTotalCalcFinal: {
            $cond: [
              { $eq: ["$waiterNameLower", "saboy"] },
              0,
              "$serviceAmountCalc",
            ],
          },
        },
      },

      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                ordersCount: { $sum: 1 },

                // ✅ tushum final (service bilan)
                revenueTotal: { $sum: "$finalTotalCalc" },

                avgCheck: { $avg: "$finalTotalCalc" },

                // ✅ jami oylik (7%)
                waitersSalaryTotal: { $sum: "$salary7Calc" },

                // ixtiyoriy (agar ko'rsatmoqchi bo'lsang):
                serviceTotal: { $sum: "$serviceTotalCalcFinal" },
                baseTotal: { $sum: "$baseTotalCalc" },
              },
            },
            {
              $project: {
                _id: 0,
                ordersCount: 1,
                revenueTotal: 1,
                avgCheck: { $ifNull: ["$avgCheck", 0] },
                waitersSalaryTotal: 1,
                serviceTotal: 1,
                baseTotal: 1,
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
      waitersSalaryTotal: 0,
      serviceTotal: 0,
      baseTotal: 0,
    };

    const paymentsRaw = agg?.[0]?.payments || [];
    const payments = { cash: 0, card: 0, click: 0 };

    for (const p of paymentsRaw) {
      const m = String(p.method || "").toLowerCase();
      if (m === "cash") payments.cash += Number(p.total || 0);
      else if (m === "card") payments.card += Number(p.total || 0);
      else if (m === "click") payments.click += Number(p.total || 0);
    }

    return res.json({
      ok: true,
      data: {
        branch: branchKey,
        range: { from, to },
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

exports.getWaitersReport = async (req, res) => {
  try {
    const branchKey = getBranchKeyFromReq(req);
    const conn = getConn(branchKey);
    if (!conn) {
      return res.status(400).json({ ok: false, message: "DB yo‘q" });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (!isValidYMD(from) || !isValidYMD(to)) {
      return res.status(400).json({ ok: false, message: "Sana xato" });
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "20", 10), 1),
      100,
    );
    const skip = (page - 1) * limit;

    const Order = getOrderModel(conn);

    const pipeline = [
      {
        $match: {
          status: "paid",
          order_date: { $gte: from, $lte: to },
        },
      },

      // 🔑 xizmat summasi (10% asos)
      {
        $addFields: {
          serviceBase: {
            $cond: [
              { $eq: [{ $toLower: "$waiter_name" }, "saboy"] },
              0,
              {
                $cond: [
                  { $gt: [{ $ifNull: ["$service_amount", 0] }, 0] },
                  "$service_amount",
                  {
                    $multiply: [{ $ifNull: ["$final_total", 0] }, 0.1],
                  },
                ],
              },
            ],
          },
        },
      },

      {
        $group: {
          _id: "$waiter_name",
          ordersCount: { $sum: 1 },
          revenueTotal: { $sum: { $ifNull: ["$final_total", 0] } },

          // ✅ 10%
          serviceTotal: { $sum: "$serviceBase" },

          // ✅ 7%
          salary7Total: {
            $sum: { $multiply: ["$serviceBase", 0.07] },
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

    const items = agg[0]?.items || [];
    const total = agg[0]?.total?.[0]?.count || 0;

    return res.json({
      ok: true,
      data: items.map((x) => ({
        waiter_name: x._id || "Noma’lum",
        ordersCount: x.ordersCount,
        revenueTotal: x.revenueTotal,
        serviceTotal: Math.round(x.serviceTotal),
        salary7Total: Math.round(x.salary7Total),
      })),
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};


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

    const category = String(req.query.category || "").trim(); // ixtiyoriy: "bar", "somsa"...

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "10", 10), 1),
      100,
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

      // category filter (agar berilgan bo'lsa)
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
          _id: {
            name: "$items.name",
            category_name: "$items.category_name",
          },

          totalQty: { $sum: { $ifNull: ["$items.quantity", 0] } },
          avgPrice: { $avg: { $ifNull: ["$items.price", 0] } },
          revenueTotal: { $sum: "$itemRevenue" },

          // nechta orderda uchragani:
          ordersSet: { $addToSet: "$_id" },
        },
      },

      {
        $addFields: {
          ordersCount: { $size: "$ordersSet" },
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
        pages: Math.ceil(total / limit),
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
      50,
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

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

      // normalize + calc
      {
        $addFields: {
          // mixedPaymentDetails null bo'lsa ham [] bo'ladi
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


          // defaultPercent: waiter_percentage > 0 bo'lsa o'sha, bo'lmasa 10
          waiterPercentEffective: {
            $cond: [
              { $gt: [{ $ifNull: ["$waiter_percentage", 0] }, 0] },
              "$waiter_percentage",
              10,
            ],
          },

          // salary: service_amount > 0 bo'lsa service_amount
          // aks holda final_total * percent
          waiterSalaryCalc: {
            $cond: [
              { $gt: [{ $ifNull: ["$service_amount", 0] }, 0] },
              "$service_amount",
              {
                $multiply: [
                  { $ifNull: ["$final_total", 0] },
                  {
                    $divide: [
                      {
                        $cond: [
                          { $gt: [{ $ifNull: ["$waiter_percentage", 0] }, 0] },
                          "$waiter_percentage",
                          10,
                        ],
                      },
                      100,
                    ],
                  },
                ],
              },
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
                revenueTotal: { $sum: { $ifNull: ["$final_total", 0] } },
                avgCheck: { $avg: { $ifNull: ["$final_total", 0] } },
                waitersSalaryTotal: { $sum: "$waiterSalaryCalc" },
              },
            },
            {
              $project: {
                _id: 0,
                ordersCount: 1,
                revenueTotal: 1,
                avgCheck: { $ifNull: ["$avgCheck", 0] },
                waitersSalaryTotal: 1,
              },
            },
          ],

          payments: [
            { $unwind: "$paymentsUnified" },
            {
              $group: {
                _id: { $toLower: { $ifNull: ["$paymentsUnified.method", "unknown"] } },
                total: { $sum: { $ifNull: ["$paymentsUnified.amount", 0] } },
              },
            },
            { $project: { _id: 0, method: "$_id", total: 1 } },
          ],
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);

    const summary =
      (agg && agg[0] && agg[0].summary && agg[0].summary[0]) || {
        ordersCount: 0,
        revenueTotal: 0,
        avgCheck: 0,
        waitersSalaryTotal: 0,
      };

    const paymentsArr = (agg && agg[0] && agg[0].payments) || [];

    // faqat kerakli 3 ta methodni ko'rsatamiz
    const payments = { cash: 0, card: 0, click: 0 };

    for (const p of paymentsArr) {
      const method = String(p.method || "").toLowerCase();
      const total = Number(p.total || 0);

      if (method === "cash") payments.cash += total;
      else if (method === "card") payments.card += total;
      else if (method === "click") payments.click += total;
      // boshqa methodlar bo'lsa hozircha e'tiborsiz qoldiramiz
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
  ? parseInt(req.query.page, 10)
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

      // salary calc (service_amount bo'lmasa 10%)
      {
        $addFields: {
          waiterSalaryCalc: {
            $cond: [
              { $gt: [{ $ifNull: ["$service_amount", 0] }, 0] },
              "$service_amount",
              { $multiply: [{ $ifNull: ["$final_total", 0] }, 0.1] },
            ],
          },
        },
      },

      {
        $group: {
          _id: { $ifNull: ["$waiter_name", "Noma'lum"] },
          ordersCount: { $sum: 1 },
          revenueTotal: { $sum: { $ifNull: ["$final_total", 0] } },
          salaryTotal: { $sum: "$waiterSalaryCalc" },
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
        salaryTotal: x.salaryTotal || 0,
      })),
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
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
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 100);
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
        ? [{ $match: { "items.category_name": { $regex: `^${category}$`, $options: "i" } } }]
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

    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
    const category = String(req.query.category || "").trim();

    const Order = getOrderModel(conn);

    const pipeline = [
      { $match: { status: "paid", order_date: { $gte: from, $lte: to } } },
      { $unwind: "$items" },

      ...(category
        ? [{ $match: { "items.category_name": { $regex: `^${category}$`, $options: "i" } } }]
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

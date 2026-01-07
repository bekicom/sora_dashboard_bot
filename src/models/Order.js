const mongoose = require("mongoose");

/**
 * Order (Chek) Schema
 * Screenshotlardagi real struktura asosida
 */

const OrderSchema = new mongoose.Schema(
  {
    daily_order_number: Number,

    order_date: String, // "2025-12-21"

    status: {
      type: String,
      enum: ["paid", "open", "cancelled"],
      index: true,
    },

    // Stol & Ofitsiant (snapshot saqlanadi)
    table_id: mongoose.Schema.Types.Mixed,
    table_number: String,

    user_id: mongoose.Schema.Types.Mixed,
    waiter_name: String,

    // Items
    items: [
      {
        food_id: mongoose.Schema.Types.Mixed,
        name: String,
        category_name: String,
        price: Number,
        quantity: Number,
      },
    ],

    // Totals
    total_price: Number,
    service_amount: Number, // 10% ofitsiant
    tax_amount: Number,
    final_total: Number,

    waiter_percentage: Number, // 10

    // Payment
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "click"],
    },
    paymentAmount: Number,
    changeAmount: Number,

    mixedPaymentDetails: [
      {
        method: String,
        amount: Number,
      },
    ],

    // Time
    createdAt: Date,
    paidAt: Date,
    closedAt: Date,

    completedBy: String,
    paidBy: String,
  },
  {
    timestamps: true,
    collection: "global_orders", // ⚠️ agar collection nomi boshqacha bo‘lsa aytasan
  }
);

/**
 * Performance indexlar
 */
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ order_date: 1 });
OrderSchema.index({ waiter_name: 1 });
OrderSchema.index({ "items.category_name": 1 });

/**
 * MODEL FACTORY
 * har bir branch connection uchun alohida model
 */
module.exports = function getOrderModel(connection) {
  return connection.models.Order || connection.model("Order", OrderSchema);
};

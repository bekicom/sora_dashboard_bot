const express = require("express");
const router = express.Router();

const reportController = require("../controllers/report.controller");


router.get("/reports/summary", reportController.getSummary);
router.get("/reports/waiters", reportController.getWaitersReport);
router.get("/reports/products", reportController.getProductsReport);
router.get("/reports/top-products", reportController.getTopProducts);
router.get("/reports/categories", reportController.getCategories); // ✅ SHU

// bot uchun api
// router.get("/orders", reportController.getOrders);
// router.get("/orders/:id", reportController.getOrderById);







module.exports = router;

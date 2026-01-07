require("dotenv").config();
const app = require("./app");
const { connectMongo } = require("./config/dbManager");

const PORT = process.env.PORT || 8043;

(async () => {
  try {
    // ✅ Bitta Mongo connection
    await connectMongo();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server start error:", err);
    process.exit(1);
  }
})();

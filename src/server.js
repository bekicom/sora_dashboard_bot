require("dotenv").config();
const app = require("./app");
const { initAllBranches } = require("./config/dbManager");

const PORT = process.env.PORT || 8043;

(async () => {
  await initAllBranches();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
})();



// starft
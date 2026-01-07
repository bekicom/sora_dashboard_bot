const mongoose = require("mongoose");

let connection = null;

/**
 * ✅ Faqat bitta Mongo URI
 */
function getMongoUri() {
  return process.env.MONGO_URI_BRANCH1;
}

/**
 * ✅ Asosiy connect
 */
async function connectMongo() {
  const uri = getMongoUri();
  if (!uri) throw new Error("MONGO_URI_BRANCH1 topilmadi");

  if (connection && connection.readyState === 1) {
    return connection;
  }

  connection = mongoose.createConnection(uri);

  await new Promise((resolve, reject) => {
    connection.once("connected", resolve);
    connection.once("error", reject);
  });

  console.log("✅ Mongo connected (single branch)");
  return connection;
}

/**
 * 🔁 Oldin ko‘p branch bo‘lgan joylar sinmasligi uchun qoldiramiz
 */
function getBranchKeyFromReq(req) {
  return "branch1";
}

/**
 * ✅ Connection olish
 */
function getConn() {
  if (!connection || connection.readyState !== 1) return null;
  return connection;
}

module.exports = {
  connectMongo,
  getBranchKeyFromReq,
  getConn,
};

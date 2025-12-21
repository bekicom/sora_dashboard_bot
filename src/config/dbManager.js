const mongoose = require("mongoose");

const connections = {};

function getMongoUri(branchKey) {
  if (branchKey === "branch1") return process.env.MONGO_URI_BRANCH1;
  if (branchKey === "branch2") return process.env.MONGO_URI_BRANCH2;
  if (branchKey === "branch3") return process.env.MONGO_URI_BRANCH3;
  return null;
}

async function connectBranch(branchKey) {
  const uri = getMongoUri(branchKey);
  if (!uri) throw new Error(`Unknown branch key: ${branchKey}`);

  if (connections[branchKey] && connections[branchKey].readyState === 1) {
    return connections[branchKey];
  }

  const conn = mongoose.createConnection(uri);

  await new Promise((resolve, reject) => {
    conn.once("connected", resolve);
    conn.once("error", reject);
  });

  connections[branchKey] = conn;
  console.log(`✅ Mongo connected: ${branchKey}`);
  return conn;
}

async function initAllBranches() {
  await Promise.all([
    connectBranch("branch1"),
    connectBranch("branch2"),
    connectBranch("branch3"),
  ]);
}

function getBranchKeyFromReq(req) {
  // query: ?branch=branch1   (default branch1)
  return String(req.query.branch || req.headers["x-branch"] || "branch1");
}

function getConn(branchKey) {
  const conn = connections[branchKey];
  if (!conn || conn.readyState !== 1) return null;
  return conn;
}

module.exports = { initAllBranches, connectBranch, getBranchKeyFromReq, getConn };

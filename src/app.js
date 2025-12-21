const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", require("./routes"));

app.get("/", (req, res) => {
  res.send("API running...");
});

module.exports = app;

const express = require("express");
const cors = require("cors");
const fs = require("fs-extra");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DB_FILE = "database.json";

async function loadDB() {
  if (!(await fs.pathExists(DB_FILE))) {
    await fs.writeJson(DB_FILE, { users: {} });
  }
  return await fs.readJson(DB_FILE);
}

async function saveDB(data) {
  await fs.writeJson(DB_FILE, data);
}

app.post("/update", async (req, res) => {
  const { userId, minedTokens, miningSpeed } = req.body;
  
  let db = await loadDB();
  db.users[userId] = {
    minedTokens,
    miningSpeed,
    lastUpdate: Date.now()
  };

  await saveDB(db);
  res.json({ success: true });
});

app.get("/users", async (req, res) => {
  let db = await loadDB();
  res.json(db.users);
});

app.listen(PORT, () => console.log(`NRX backend running on port ${PORT}`));

// server.js (REPLACEMENT - hardened + fixes for missing keys and safe updates)

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // For serving frontend if needed

const PORT = process.env.PORT || 10000;
const DB_FILE = path.join(__dirname, 'database.json');

// Default DB shape (used to merge with existing file)
const DEFAULT_DB = {
  users: {},
  sessions: {},
  withdrawals: {},
  activities: [],
  boosts: [],
  stats: {
    totalUsers: 0,
    totalMined: 0,
    totalWithdrawals: 0,
    activeSessions: 0,
    totalBoostCount: 0,
    totalWithdrawalCount: 0
  }
};

// Initialize database if not exists (creates a complete DB file)
function initDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
      console.log('Database initialized (created new file)');
    } catch (err) {
      console.error('Failed to initialize database file:', err);
    }
  } else {
    // Ensure DB has all required keys (merge defaults)
    const db = readDB();
    let changed = false;
    for (const key of Object.keys(DEFAULT_DB)) {
      if (db[key] === undefined) {
        db[key] = DEFAULT_DB[key];
        changed = true;
      } else {
        // ensure nested stats keys exist
        if (key === 'stats') {
          for (const sKey of Object.keys(DEFAULT_DB.stats)) {
            if (db.stats[sKey] === undefined) {
              db.stats[sKey] = DEFAULT_DB.stats[sKey];
              changed = true;
            }
          }
        }
      }
    }
    if (changed) {
      writeDB(db);
      console.log('Database merged with defaults (missing keys added).');
    }
  }
}

// Read database and always return a fully shaped object
function readDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');

    // Merge with defaults (non-destructive)
    const merged = Object.assign({}, DEFAULT_DB, parsed);

    // Ensure correct types for collections
    merged.users = merged.users || {};
    merged.sessions = merged.sessions || {};
    merged.withdrawals = merged.withdrawals || {};
    merged.activities = Array.isArray(merged.activities) ? merged.activities : [];
    merged.boosts = Array.isArray(merged.boosts) ? merged.boosts : [];
    merged.stats = Object.assign({}, DEFAULT_DB.stats, merged.stats || {});

    return merged;
  } catch (error) {
    console.error('Error reading database:', error);
    // return safe DB
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

// Atomic write to database (write to temp then rename)
function writeDB(data) {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DB_FILE);
    return true;
  } catch (error) {
    console.error('Error writing to database:', error);
    return false;
  }
}

// Generate unique ID (timestamp + random)
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Clean up old sessions (older than 24 hours)
function cleanupOldSessions() {
  const db = readDB();
  const now = new Date();
  const cutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000));

  let cleaned = 0;
  Object.keys(db.sessions).forEach(sessionId => {
    const session = db.sessions[sessionId];
    const lastActive = new Date(session.lastActive || session.startedAt || 0);

    if (lastActive < cutoff) {
      delete db.sessions[sessionId];
      cleaned++;
    }
  });

  if (cleaned > 0) {
    db.stats.activeSessions = Object.keys(db.sessions).length;
    // Recompute totalUsers as sessions count (safe fallback)
    db.stats.totalUsers = Object.keys(db.sessions).length;
    writeDB(db);
    console.log(`Cleaned up ${cleaned} old sessions`);
  }
}

// ---------- API ENDPOINTS ----------

// 1. Create session
app.post('/api/session', (req, res) => {
  const db = readDB();
  const sessionId = generateId();

  db.sessions[sessionId] = {
    id: sessionId,
    userAgent: req.body.ua || 'Unknown',
    startedAt: req.body.startedAt || new Date().toISOString(),
    lastActive: new Date().toISOString(),
    minedTokens: 0,
    miningSpeed: 20,
    completedTasks: [],
    totalMiningTime: 0,
    withdrawals: [],
    boosts: [],
    dailyMined: 0,
    lastResetDate: new Date().toDateString()
  };

  // Update stats
  db.stats.activeSessions = Object.keys(db.sessions).length;
  db.stats.totalUsers = Object.keys(db.sessions).length;

  const ok = writeDB(db);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to write DB' });
  }

  res.json({
    sessionId,
    message: 'Session created',
    miningSpeed: 20,
    dailyLimit: 20
  });
});

// 2. Get session state
app.get('/api/session/:sessionId/state', (req, res) => {
  const db = readDB();
  const session = db.sessions[req.params.sessionId];

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Check daily reset
  const today = new Date().toDateString();
  if (session.lastResetDate !== today) {
    session.dailyMined = 0;
    session.lastResetDate = today;
  }

  // Update last active
  session.lastActive = new Date().toISOString();

  // persist possible changes
  writeDB(db);

  res.json({
    minedTokens: Number(session.minedTokens || 0),
    dailyMined: Number(session.dailyMined || 0),
    miningSpeed: Number(session.miningSpeed || 20),
    completedTasks: Array.isArray(session.completedTasks) ? session.completedTasks : [],
    totalMiningTime: Number(session.totalMiningTime || 0),
    dailyLimit: 20
  });
});

// 3. Save session state
app.post('/api/session/:sessionId/state', (req, res) => {
  const db = readDB();
  const session = db.sessions[req.params.sessionId];

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Only update if fields are provided (don't clobber zeros)
  if (req.body.minedTokens !== undefined) {
    session.minedTokens = Number(req.body.minedTokens) || 0;
  }
  if (req.body.miningSpeed !== undefined) {
    session.miningSpeed = Number(req.body.miningSpeed) || session.miningSpeed;
  }
  if (req.body.completedTasks !== undefined && Array.isArray(req.body.completedTasks)) {
    session.completedTasks = req.body.completedTasks;
  }
  if (req.body.totalMiningTime !== undefined) {
    session.totalMiningTime = Number(req.body.totalMiningTime) || session.totalMiningTime;
  }
  if (req.body.dailyMined !== undefined) {
    session.dailyMined = Number(req.body.dailyMined) || session.dailyMined || 0;
  }

  session.lastActive = new Date().toISOString();

  // Recompute global stats safely
  try {
    db.stats.totalMined = Object.values(db.sessions).reduce((sum, s) => {
      const val = Number(s.minedTokens || 0);
      return sum + (isNaN(val) ? 0 : val);
    }, 0);
  } catch (err) {
    db.stats.totalMined = 0;
  }

  const ok = writeDB(db);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to write DB' });
  }

  res.json({
    success: true,
    message: 'State saved',
    dailyMined: session.dailyMined,
    dailyLimit: 20
  });
});

// 4. Create boost
app.post('/api/boosts', (req, res) => {
  const db = readDB();
  const { sessionId, requestedAt } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = db.sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Generate boost amount (10-25 H/s)
  const boostAmount = 10 + Math.floor(Math.random() * 15);
  const boostId = generateId();

  const boost = {
    id: boostId,
    sessionId,
    boostAmount,
    createdAt: requestedAt || new Date().toISOString(),
    verified: false,
    taskType: req.body.taskType || 'general'
  };

  db.boosts = Array.isArray(db.boosts) ? db.boosts : [];
  db.boosts.push(boost);
  session.boosts = Array.isArray(session.boosts) ? session.boosts : [];
  session.boosts.push(boostId);

  db.stats.totalBoostCount = db.boosts.length;

  const ok = writeDB(db);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to write DB' });
  }

  res.json({
    boostId,
    boostAmount,
    message: 'Boost created (requires OGADS verification)'
  });
});

// 5. Verify boost (after OGADS completion)
app.post('/api/boosts/:boostId/verify', (req, res) => {
  const db = readDB();
  const { sessionId } = req.body;
  const boostIndex = (db.boosts || []).findIndex(b => b.id === req.params.boostId);

  if (boostIndex === -1) {
    return res.status(404).json({ error: 'Boost not found' });
  }

  const boost = db.boosts[boostIndex];

  if (sessionId !== boost.sessionId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Mark as verified and apply boost safely
  boost.verified = true;
  boost.verifiedAt = new Date().toISOString();

  const session = db.sessions[sessionId];
  if (session) {
    session.miningSpeed = Number(session.miningSpeed || 20) + Number(boost.boostAmount || 0);

    // Add to completed tasks if not already (use a stable task id)
    const taskId = `boost-${boost.id}`;
    session.completedTasks = Array.isArray(session.completedTasks) ? session.completedTasks : [];
    if (!session.completedTasks.includes(taskId)) {
      session.completedTasks.push(taskId);
    }

    session.lastActive = new Date().toISOString();
  }

  writeDB(db);
  res.json({
    success: true,
    boostAmount: boost.boostAmount,
    newSpeed: session ? session.miningSpeed : 0,
    message: 'Boost verified and applied'
  });
});

// 6. Create withdrawal
app.post('/api/withdrawals', (req, res) => {
  const db = readDB();
  const { sessionId, walletAddress, amount, network = 'bsc' } = req.body;

  if (!sessionId || !walletAddress || amount === undefined) {
    return res.status(400).json({ error: 'sessionId, walletAddress and amount are required' });
  }

  const session = db.sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const withdrawalAmount = Number(amount);
  if (isNaN(withdrawalAmount)) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Check sufficient balance
  if (Number(session.minedTokens || 0) < withdrawalAmount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  // Check minimum
  if (withdrawalAmount < 0.001) {
    return res.status(400).json({ error: 'Minimum withdrawal is 0.001 NRX' });
  }

  const withdrawalId = generateId();
  const withdrawal = {
    id: withdrawalId,
    sessionId,
    walletAddress,
    amount: withdrawalAmount,
    network,
    status: 'pending', // pending, processing, completed, failed
    createdAt: new Date().toISOString(),
    ogadsVerified: false
  };

  // Deduct from session balance immediately (local hold)
  session.minedTokens = Number(session.minedTokens || 0) - withdrawalAmount;
  session.withdrawals = Array.isArray(session.withdrawals) ? session.withdrawals : [];
  session.withdrawals.push(withdrawalId);
  session.lastActive = new Date().toISOString();

  db.withdrawals = db.withdrawals || {};
  db.withdrawals[withdrawalId] = withdrawal;

  db.stats.totalWithdrawals = Number(db.stats.totalWithdrawals || 0) + withdrawalAmount;
  db.stats.totalWithdrawalCount = Object.keys(db.withdrawals).length;

  writeDB(db);
  res.json({
    withdrawalId,
    message: 'Withdrawal created (requires OGADS verification)',
    newBalance: session.minedTokens
  });
});

// 7. Complete withdrawal (after OGADS verification)
app.post('/api/withdrawals/:withdrawalId/complete', (req, res) => {
  const db = readDB();
  const { sessionId } = req.body;
  const withdrawal = db.withdrawals && db.withdrawals[req.params.withdrawalId];

  if (!withdrawal) {
    return res.status(404).json({ error: 'Withdrawal not found' });
  }

  if (withdrawal.sessionId !== sessionId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (withdrawal.status === 'completed') {
    return res.status(400).json({ error: 'Withdrawal already completed' });
  }

  withdrawal.status = 'completed';
  withdrawal.completedAt = new Date().toISOString();
  withdrawal.ogadsVerified = true;

  const session = db.sessions[sessionId];
  if (session) {
    session.lastActive = new Date().toISOString();
  }

  writeDB(db);
  res.json({
    success: true,
    message: 'Withdrawal completed successfully',
    withdrawal: {
      id: withdrawal.id,
      amount: withdrawal.amount,
      walletAddress: withdrawal.walletAddress,
      completedAt: withdrawal.completedAt
    }
  });
});

// 8. Track activity
app.post('/api/activity', (req, res) => {
  const db = readDB();
  const activity = {
    id: generateId(),
    sessionId: req.body.sessionId,
    type: req.body.type || 'unknown',
    data: req.body.data || {},
    timestamp: new Date().toISOString()
  };

  db.activities = Array.isArray(db.activities) ? db.activities : [];
  db.activities.push(activity);

  // Keep only last 1000 activities
  if (db.activities.length > 1000) {
    db.activities = db.activities.slice(-1000);
  }

  writeDB(db);
  res.json({ success: true, message: 'Activity logged' });
});

// 9. Get statistics (for admin dashboard)
app.get('/api/stats', (req, res) => {
  const db = readDB();

  const pendingWithdrawals = Object.values(db.withdrawals || {}).filter(w => w.status === 'pending').length;
  const completedWithdrawals = Object.values(db.withdrawals || {}).filter(w => w.status === 'completed').length;

  const stats = {
    ...db.stats,
    totalSessions: Object.keys(db.sessions || {}).length,
    totalBoosts: Array.isArray(db.boosts) ? db.boosts.length : 0,
    totalActivities: Array.isArray(db.activities) ? db.activities.length : 0,
    totalWithdrawalCount: Object.keys(db.withdrawals || {}).length,
    pendingWithdrawals,
    completedWithdrawals,
    recentActivities: (db.activities || []).slice(-10).reverse(),
    recentWithdrawals: Object.values(db.withdrawals || {})
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
  };

  res.json(stats);
});

// 10. Get all sessions (admin)
app.get('/api/admin/sessions', (req, res) => {
  const db = readDB();
  res.json({
    total: Object.keys(db.sessions || {}).length,
    sessions: db.sessions || {}
  });
});

// 11. Get session details
app.get('/api/admin/session/:sessionId', (req, res) => {
  const db = readDB();
  const session = db.sessions[req.params.sessionId];

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const sessionWithdrawals = (session.withdrawals || []).map(id => db.withdrawals[id]).filter(Boolean);
  const sessionBoosts = (db.boosts || []).filter(b => b.sessionId === req.params.sessionId);

  res.json({
    session,
    withdrawals: sessionWithdrawals,
    boosts: sessionBoosts
  });
});

// 12. Health check
app.get('/api/health', (req, res) => {
  try {
    const db = readDB();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        sessions: Object.keys(db.sessions || {}).length,
        withdrawals: Object.keys(db.withdrawals || {}).length,
        boosts: Array.isArray(db.boosts) ? db.boosts.length : 0,
        activities: Array.isArray(db.activities) ? db.activities.length : 0
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 13. Ping endpoint (for keeping free tier awake)
app.get('/api/ping', (req, res) => {
  res.json({
    pong: Date.now(),
    message: 'Server is awake',
    timestamp: new Date().toISOString()
  });
});

// ---------- FRONTEND SERVING (Optional) ----------
app.get('/', (req, res) => {
  res.send(`<html><body><h1>Neura Token Backend</h1><p>API is running</p><p><a href="/api/health">Health</a> | <a href="/api/stats">Stats</a></p></body></html>`);
});

// ---------- AUTO-PING SYSTEM (Prevent Render sleep) ----------
if (process.env.RENDER) {
  console.log('Render environment detected - enabling auto-ping');

  const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
  async function selfPing() {
    try {
      const response = await fetch(`http://localhost:${PORT}/api/ping`);
      await response.json();
      console.log(`Auto-ping successful: ${new Date().toISOString()}`);
    } catch (error) {
      console.warn('Auto-ping failed:', error.message);
    }
  }
  setTimeout(() => {
    selfPing();
    setInterval(selfPing, PING_INTERVAL);
  }, 60000);
}

// ---------- CLEANUP SCHEDULER ----------
setInterval(cleanupOldSessions, 60 * 60 * 1000);

// ---------- START SERVER ----------
initDatabase();
cleanupOldSessions();

app.listen(PORT, () => {
  console.log(`🚀 Neura Token Backend running on port ${PORT}`);
  console.log(`📊 Database file: ${DB_FILE}`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
});

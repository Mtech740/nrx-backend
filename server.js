const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // For serving frontend if needed

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// Initialize database if not exists
function initDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = {
            users: {},
            sessions: {},
            withdrawals: {},
            activities: [],
            boosts: [],
            stats: {
                totalUsers: 0,
                totalMined: 0,
                totalWithdrawals: 0,
                activeSessions: 0
            }
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    }
}

// Read database
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return { users: {}, sessions: {}, withdrawals: {}, activities: [], boosts: [], stats: { totalUsers: 0, totalMined: 0, totalWithdrawals: 0, activeSessions: 0 } };
    }
}

// Write to database
function writeDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing to database:', error);
        return false;
    }
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
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
        boosts: []
    };
    
    db.stats.activeSessions = Object.keys(db.sessions).length;
    writeDB(db);
    
    res.json({ sessionId, message: 'Session created' });
});

// 2. Get session state
app.get('/api/session/:sessionId/state', (req, res) => {
    const db = readDB();
    const session = db.sessions[req.params.sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    // Update last active
    session.lastActive = new Date().toISOString();
    writeDB(db);
    
    res.json({
        minedTokens: session.minedTokens,
        miningSpeed: session.miningSpeed,
        completedTasks: session.completedTasks,
        totalMiningTime: session.totalMiningTime
    });
});

// 3. Save session state
app.post('/api/session/:sessionId/state', (req, res) => {
    const db = readDB();
    const session = db.sessions[req.params.sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    // Update session data
    session.minedTokens = req.body.minedTokens || session.minedTokens;
    session.miningSpeed = req.body.miningSpeed || session.miningSpeed;
    session.completedTasks = req.body.completedTasks || session.completedTasks;
    session.totalMiningTime = req.body.totalMiningTime || session.totalMiningTime;
    session.lastActive = new Date().toISOString();
    
    // Update global stats
    db.stats.totalMined = Object.values(db.sessions).reduce((sum, s) => sum + s.minedTokens, 0);
    
    writeDB(db);
    res.json({ success: true, message: 'State saved' });
});

// 4. Create boost
app.post('/api/boosts', (req, res) => {
    const db = readDB();
    const { sessionId, requestedAt } = req.body;
    const session = db.sessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    // Generate boost amount (10-25 H/s)
    const boostAmount = 10 + Math.floor(Math.random() * 15);
    const boostId = generateId();
    
    const boost = {
        id: boostId,
        sessionId,
        boostAmount,
        createdAt: requestedAt || new Date().toISOString(),
        verified: false
    };
    
    db.boosts.push(boost);
    session.boosts.push(boostId);
    writeDB(db);
    
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
    const boost = db.boosts.find(b => b.id === req.params.boostId);
    
    if (!boost) {
        return res.status(404).json({ error: 'Boost not found' });
    }
    
    if (boost.sessionId !== sessionId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Mark as verified and apply boost
    boost.verified = true;
    boost.verifiedAt = new Date().toISOString();
    
    const session = db.sessions[sessionId];
    if (session) {
        session.miningSpeed += boost.boostAmount;
        
        // Add to completed tasks if not already
        if (!session.completedTasks.includes(boost.id)) {
            session.completedTasks.push(boost.id);
        }
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
    const session = db.sessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    // Check if user has enough tokens
    if (session.minedTokens < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Check minimum withdrawal
    if (amount < 0.001) {
        return res.status(400).json({ error: 'Minimum withdrawal is 0.001 NRX' });
    }
    
    const withdrawalId = generateId();
    const withdrawal = {
        id: withdrawalId,
        sessionId,
        walletAddress,
        amount: parseFloat(amount),
        network,
        status: 'pending', // pending, processing, completed, failed
        createdAt: new Date().toISOString(),
        ogadsVerified: false
    };
    
    // Deduct from session balance immediately
    session.minedTokens -= amount;
    session.withdrawals.push(withdrawalId);
    
    db.withdrawals[withdrawalId] = withdrawal;
    db.stats.totalWithdrawals += amount;
    
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
    const withdrawal = db.withdrawals[req.params.withdrawalId];
    
    if (!withdrawal) {
        return res.status(404).json({ error: 'Withdrawal not found' });
    }
    
    if (withdrawal.sessionId !== sessionId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (withdrawal.status === 'completed') {
        return res.status(400).json({ error: 'Withdrawal already completed' });
    }
    
    // Mark as completed
    withdrawal.status = 'completed';
    withdrawal.completedAt = new Date().toISOString();
    withdrawal.ogadsVerified = true;
    
    writeDB(db);
    res.json({ 
        success: true, 
        message: 'Withdrawal completed successfully',
        withdrawal
    });
});

// 8. Track activity
app.post('/api/activity', (req, res) => {
    const db = readDB();
    const activity = {
        id: generateId(),
        ...req.body,
        timestamp: new Date().toISOString()
    };
    
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
    
    const stats = {
        ...db.stats,
        totalSessions: Object.keys(db.sessions).length,
        totalBoosts: db.boosts.length,
        totalActivities: db.activities.length,
        totalWithdrawalCount: Object.keys(db.withdrawals).length,
        pendingWithdrawals: Object.values(db.withdrawals).filter(w => w.status === 'pending').length,
        recentActivities: db.activities.slice(-10)
    };
    
    res.json(stats);
});

// 10. Admin: Get all data (use with caution!)
app.get('/api/admin/data', (req, res) => {
    const db = readDB();
    res.json(db);
});

// 11. Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ---------- FRONTEND SERVING (Optional) ----------
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Neura Token Backend</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                h1 { color: #2a4b8d; }
                .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
                code { background: #e0e0e0; padding: 2px 5px; border-radius: 3px; }
            </style>
        </head>
        <body>
            <h1>🚀 Neura Token Backend API</h1>
            <p>Backend is running successfully!</p>
            <div class="endpoint">
                <strong>POST</strong> <code>/api/session</code> - Create new session
            </div>
            <div class="endpoint">
                <strong>GET</strong> <code>/api/session/:id/state</code> - Get session state
            </div>
            <div class="endpoint">
                <strong>POST</strong> <code>/api/session/:id/state</code> - Save session state
            </div>
            <div class="endpoint">
                <strong>POST</strong> <code>/api/withdrawals</code> - Create withdrawal
            </div>
            <div class="endpoint">
                <strong>POST</strong> <code>/api/withdrawals/:id/complete</code> - Complete withdrawal
            </div>
            <div class="endpoint">
                <strong>GET</strong> <code>/api/stats</code> - Get statistics
            </div>
            <p><a href="/api/health">Health Check</a> | <a href="/api/stats">Statistics</a></p>
        </body>
        </html>
    `);
});

// ---------- START SERVER ----------
initDatabase();
app.listen(PORT, () => {
    console.log(`🚀 Neura Token Backend running on port ${PORT}`);
    console.log(`📊 Database file: ${DB_FILE}`);
    console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
});

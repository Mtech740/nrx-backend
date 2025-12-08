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
                activeSessions: 0,
                totalBoostCount: 0,
                totalWithdrawalCount: 0
            }
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        console.log('Database initialized');
    }
}

// Read database
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return { 
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

// Clean up old sessions (older than 24 hours)
function cleanupOldSessions() {
    const db = readDB();
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    
    let cleaned = 0;
    Object.keys(db.sessions).forEach(sessionId => {
        const session = db.sessions[sessionId];
        const lastActive = new Date(session.lastActive || session.startedAt);
        
        if (lastActive < twentyFourHoursAgo) {
            delete db.sessions[sessionId];
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        db.stats.activeSessions = Object.keys(db.sessions).length;
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
    
    db.stats.activeSessions = Object.keys(db.sessions).length;
    db.stats.totalUsers = Object.keys(db.sessions).length;
    writeDB(db);
    
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
        writeDB(db);
    }
    
    // Update last active
    session.lastActive = new Date().toISOString();
    writeDB(db);
    
    res.json({
        minedTokens: session.minedTokens,
        dailyMined: session.dailyMined || 0,
        miningSpeed: session.miningSpeed,
        completedTasks: session.completedTasks,
        totalMiningTime: session.totalMiningTime,
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
    
    // Update session data
    session.minedTokens = req.body.minedTokens || session.minedTokens;
    session.miningSpeed = req.body.miningSpeed || session.miningSpeed;
    session.completedTasks = req.body.completedTasks || session.completedTasks;
    session.totalMiningTime = req.body.totalMiningTime || session.totalMiningTime;
    session.lastActive = new Date().toISOString();
    
    // Update daily mined
    if (req.body.dailyMined !== undefined) {
        session.dailyMined = req.body.dailyMined;
    }
    
    // Update global stats
    db.stats.totalMined = Object.values(db.sessions).reduce((sum, s) => sum + s.minedTokens, 0);
    
    writeDB(db);
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
        verified: false,
        taskType: req.body.taskType || 'general'
    };
    
    db.boosts.push(boost);
    session.boosts.push(boostId);
    db.stats.totalBoostCount = db.boosts.length;
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
    const boostIndex = db.boosts.findIndex(b => b.id === req.params.boostId);
    
    if (boostIndex === -1) {
        return res.status(404).json({ error: 'Boost not found' });
    }
    
    const boost = db.boosts[boostIndex];
    
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
        const taskId = `boost-${boost.id}`;
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
    const session = db.sessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    const withdrawalAmount = parseFloat(amount);
    
    // Check if user has enough tokens
    if (session.minedTokens < withdrawalAmount) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Check minimum withdrawal
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
    
    // Deduct from session balance immediately
    session.minedTokens -= withdrawalAmount;
    session.withdrawals.push(withdrawalId);
    session.lastActive = new Date().toISOString();
    
    db.withdrawals[withdrawalId] = withdrawal;
    db.stats.totalWithdrawals += withdrawalAmount;
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
        completedWithdrawals: Object.values(db.withdrawals).filter(w => w.status === 'completed').length,
        recentActivities: db.activities.slice(-10).reverse(),
        recentWithdrawals: Object.values(db.withdrawals)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 10)
    };
    
    res.json(stats);
});

// 10. Get all sessions (admin)
app.get('/api/admin/sessions', (req, res) => {
    const db = readDB();
    res.json({
        total: Object.keys(db.sessions).length,
        sessions: db.sessions
    });
});

// 11. Get session details
app.get('/api/admin/session/:sessionId', (req, res) => {
    const db = readDB();
    const session = db.sessions[req.params.sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    const sessionWithdrawals = session.withdrawals.map(id => db.withdrawals[id]).filter(Boolean);
    const sessionBoosts = db.boosts.filter(b => b.sessionId === req.params.sessionId);
    
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
                sessions: Object.keys(db.sessions).length,
                withdrawals: Object.keys(db.withdrawals).length,
                boosts: db.boosts.length,
                activities: db.activities.length
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
                .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
                .healthy { background: #d4edda; color: #155724; }
                .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 20px 0; }
                .stat-box { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            </style>
        </head>
        <body>
            <h1>🚀 Neura Token Backend API</h1>
            <p>Backend is running successfully!</p>
            
            <div class="status healthy">
                <strong>Status:</strong> Healthy | <strong>Uptime:</strong> ${Math.floor(process.uptime())} seconds
            </div>
            
            <div class="stats" id="stats">
                <!-- Stats will be loaded by JavaScript -->
            </div>
            
            <h3>Available Endpoints:</h3>
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
            <div class="endpoint">
                <strong>GET</strong> <code>/api/health</code> - Health check
            </div>
            <div class="endpoint">
                <strong>GET</strong> <code>/api/ping</code> - Keep server awake
            </div>
            
            <p>
                <a href="/api/health">Health Check</a> | 
                <a href="/api/stats">Statistics</a> | 
                <a href="/api/ping">Ping</a>
            </p>
            
            <script>
                async function loadStats() {
                    try {
                        const response = await fetch('/api/stats');
                        const data = await response.json();
                        
                        const statsDiv = document.getElementById('stats');
                        statsDiv.innerHTML = \`
                            <div class="stat-box">
                                <h4>Sessions</h4>
                                <p>\${data.totalSessions} active</p>
                            </div>
                            <div class="stat-box">
                                <h4>Total Mined</h4>
                                <p>\${data.totalMined.toFixed(2)} NRX</p>
                            </div>
                            <div class="stat-box">
                                <h4>Withdrawals</h4>
                                <p>\${data.totalWithdrawalCount} total</p>
                                <p>\${data.pendingWithdrawals} pending</p>
                            </div>
                            <div class="stat-box">
                                <h4>Boosts</h4>
                                <p>\${data.totalBoosts} total</p>
                            </div>
                        \`;
                    } catch (error) {
                        console.error('Failed to load stats:', error);
                    }
                }
                
                loadStats();
                // Auto-refresh stats every 30 seconds
                setInterval(loadStats, 30000);
            </script>
        </body>
        </html>
    `);
});

// ---------- AUTO-PING SYSTEM (Prevent Render sleep) ----------
if (process.env.RENDER) {
    console.log('🔧 Render environment detected - enabling auto-ping');
    
    // Self-ping every 14 minutes to keep instance awake
    const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
    
    async function selfPing() {
        try {
            const response = await fetch(`http://localhost:${PORT}/api/ping`);
            const data = await response.json();
            console.log(`🔄 Auto-ping successful: ${new Date().toISOString()}`);
        } catch (error) {
            console.warn('Auto-ping failed:', error.message);
        }
    }
    
    // Start auto-ping after 1 minute, then every 14 minutes
    setTimeout(() => {
        selfPing();
        setInterval(selfPing, PING_INTERVAL);
    }, 60000);
}

// ---------- CLEANUP SCHEDULER ----------
// Clean up old sessions every hour
setInterval(cleanupOldSessions, 60 * 60 * 1000);

// ---------- START SERVER ----------
initDatabase();
cleanupOldSessions(); // Run once on startup

app.listen(PORT, () => {
    console.log(`🚀 Neura Token Backend running on port ${PORT}`);
    console.log(`📊 Database file: ${DB_FILE}`);
    console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
    console.log(`🌍 Public URL: https://nrx-backend-2.onrender.com`);
    
    if (process.env.RENDER) {
        console.log(`🔧 Auto-ping enabled to prevent sleep`);
    }
});

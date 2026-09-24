/**
 * ============================================================================
 * KAMMAL APP — ULTRA FULL-POWER BACKEND & ADMIN GOVERNANCE ENGINE
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Serve static web assets (Glassmorphic Admin Dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// 1. MONGODB ATLAS CONNECTION
// ============================================================================
const MONGODB_URI = process.env.MONGODB_URI || 
  "mongodb+srv://pukathub_db_user:AWiAL8UUwrOQ6h33@cluster0.y2lzfvn.mongodb.net/MyUsersDB?retryWrites=true&w=majority";

let cachedDb = null;

async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        return cachedDb;
    }
    try {
        mongoose.set('strictQuery', false);
        const db = await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 8000,
            socketTimeoutMS: 45000,
        });
        cachedDb = db;
        console.log("✅ [MONGODB] Connected to Atlas MyUsersDB successfully.");
        return db;
    } catch (err) {
        console.warn("⚠️ [MONGODB] Live connection error, operating in memory fallback:", err.message);
        return null;
    }
}
connectToDatabase();

const memoryStore = {
    users: new Map(),
    keys: new Map(),
    chatMessages: [],
    supportMessages: [],
    payments: [],
    config: null
};

// ============================================================================
// 2. MONGOOSE DATA MODELS
// ============================================================================

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    token: { type: String, default: '' },
    deviceId: { type: String, default: '', index: true },
    credits: { type: Number, default: 20 },
    isPro: { type: Boolean, default: false },
    proPlan: { type: String, enum: ['none', 'trial', 'monthly', 'yearly', 'lifetime'], default: 'trial' },
    planExpiry: { type: String, default: 'Lifetime' },
    tier: { type: String, default: 'FREE' },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    banReason: { type: String, default: '' },
    referralCode: { type: String, default: '' },
    referredBy: { type: String, default: '' },
    customPrompt: { type: String, default: '' },
    stats: {
        videosPatched: { type: Number, default: 0 },
        videosEnhanced4K: { type: Number, default: 0 }
    },
    lastActiveAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const RedeemKeySchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    credits: { type: Number, default: 100 },
    plan: { type: String, default: 'PRO' },
    isPro: { type: Boolean, default: true },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: String, default: '' },
    usedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
});
const RedeemKey = mongoose.models.RedeemKey || mongoose.model('RedeemKey', RedeemKeySchema);

const PaymentProofSchema = new mongoose.Schema({
    username: { type: String, required: true },
    method: { type: String, enum: ['jazzcash', 'easypaisa', 'bank'], default: 'jazzcash' },
    transactionId: { type: String, required: true },
    amount: { type: Number, default: 500 },
    requestedPlan: { type: String, default: 'PRO' },
    requestedCredits: { type: Number, default: 1000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const PaymentProof = mongoose.models.PaymentProof || mongoose.model('PaymentProof', PaymentProofSchema);

const ChatMessageSchema = new mongoose.Schema({
    channel: { type: String, default: 'global' },
    sender: { type: String, required: true },
    recipient: { type: String, default: 'global' },
    text: { type: String, required: true },
    isOwner: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    timestamp: { type: Number, default: Date.now }
});
const ChatMessage = mongoose.models.ChatMessage || mongoose.model('ChatMessage', ChatMessageSchema);

const SupportMessageSchema = new mongoose.Schema({
    sender: { type: String, required: true },
    deviceId: { type: String, default: '' },
    message: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    timestamp: { type: Number, default: Date.now }
});
const SupportMessage = mongoose.models.SupportMessage || mongoose.model('SupportMessage', SupportMessageSchema);

const AppConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'global_config', unique: true },
    maintenance: {
        enabled: { type: Boolean, default: false },
        message: { type: String, default: 'Kammal App is currently under maintenance.' }
    },
    minAppVersion: { type: String, default: '1.0.0' },
    latestAppVersion: { type: String, default: '3.5.0' },
    updateUrl: { type: String, default: '' },
    forceUpdate: { type: Boolean, default: false },
    systemPrompt: { type: String, default: 'You are Kammal AI video optimization specialist.' },
    currentModel: { type: String, default: 'gemini-2.5-flash' },
    referralReward: { type: Number, default: 10 }
});
const AppConfig = mongoose.models.AppConfig || mongoose.model('AppConfig', AppConfigSchema);

async function getActiveConfig() {
    await connectToDatabase();
    if (mongoose.connection.readyState === 1) {
        let conf = await AppConfig.findOne({ key: 'global_config' });
        if (!conf) conf = await AppConfig.create({ key: 'global_config' });
        return conf;
    }
    return {
        maintenance: { enabled: false, message: 'Maintenance' },
        systemPrompt: 'You are Kammal AI',
        currentModel: 'gemini-2.5-flash'
    };
}

function hashPassword(pass) {
    if (!pass) return '';
    return crypto.createHash('sha256').update(String(pass)).digest('hex');
}
function generateToken(username) {
    return 'kammal_' + crypto.randomBytes(24).toString('hex');
}

// Admin Credentials
const ADMIN_USER = 'adMIN';
const ADMIN_PASS = 'ADmin';

function requireAdminAuth(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    const authHeader = req.headers['authorization'];
    if (adminKey === ADMIN_PASS || adminKey === 'admin' || adminKey === 'ADmin') return next();
    if (authHeader && (authHeader === `Bearer ${ADMIN_PASS}` || authHeader.includes('ADmin') || authHeader.includes('admin_master'))) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized: Admin authentication required.' });
}

let genAI = null;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// ============================================================================
// 3. PUBLIC APP CONFIG & HEALTH
// ============================================================================
app.get('/api/app/config', async (req, res) => {
    try {
        const conf = await getActiveConfig();
        res.json({
            success: true,
            maintenance: conf.maintenance,
            minAppVersion: conf.minAppVersion,
            latestAppVersion: conf.latestAppVersion,
            forceUpdate: conf.forceUpdate,
            updateUrl: conf.updateUrl
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: "OK",
        version: "3.5.0",
        database: mongoose.connection.readyState === 1 ? "ONLINE (MongoDB Atlas)" : "MEMORY MODE",
        time: Date.now()
    });
});

// ============================================================================
// 4. AUTHENTICATION & DEVICE BINDING
// ============================================================================
const handleRegister = async (req, res) => {
    await connectToDatabase();
    const conf = await getActiveConfig();
    if (conf.maintenance?.enabled) {
        return res.status(503).json({ success: false, error: conf.maintenance.message });
    }

    const { username, password, name, email, phone, deviceId, referralCode } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: "Username & Password required" });

    const cleanUsername = String(username).trim();
    const pHash = hashPassword(password);
    const token = generateToken(cleanUsername);

    try {
        if (mongoose.connection.readyState === 1) {
            const existing = await User.findOne({ username: cleanUsername });
            if (existing) return res.status(400).json({ success: false, error: "Username already taken." });

            if (deviceId) {
                const bound = await User.findOne({ deviceId: deviceId.trim(), status: 'active' });
                if (bound && bound.username !== cleanUsername) {
                    return res.status(400).json({
                        success: false,
                        error: `Device Bound: This physical phone is already bound to '${bound.username}'. Please contact Admin for reset.`
                    });
                }
            }

            let bonusCredits = 20;
            if (referralCode) {
                const refUser = await User.findOne({ referralCode: referralCode.trim() });
                if (refUser) {
                    refUser.credits += 10;
                    await refUser.save();
                    bonusCredits += 10;
                }
            }

            const newUser = await User.create({
                username: cleanUsername,
                name: name || cleanUsername,
                email: email || '',
                phone: phone || '',
                passwordHash: pHash,
                token,
                deviceId: deviceId ? deviceId.trim() : '',
                credits: bonusCredits,
                referralCode: 'KAM-' + cleanUsername.toUpperCase().slice(0, 4) + '-' + Math.floor(1000 + Math.random() * 9000),
                status: 'active'
            });

            return res.json({ success: true, message: "Registered", token, user: newUser });
        }
        res.json({ success: true, token, user: { username: cleanUsername, credits: 20 } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};
app.post('/api/auth/register', handleRegister);
app.post('/api/register', handleRegister);

const handleLogin = async (req, res) => {
    await connectToDatabase();
    const conf = await getActiveConfig();
    if (conf.maintenance?.enabled) return res.status(503).json({ success: false, error: conf.maintenance.message });

    const { email, password, deviceId } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: "Credentials required" });

    const identifier = String(email).trim();
    const pHash = hashPassword(password);
    const token = generateToken(identifier);

    try {
        if (mongoose.connection.readyState === 1) {
            const user = await User.findOne({
                $or: [{ username: identifier }, { email: identifier }, { phone: identifier }]
            });
            if (!user) return res.status(401).json({ success: false, error: "User not found." });
            if (user.passwordHash !== pHash) return res.status(401).json({ success: false, error: "Incorrect password." });
            if (user.status === 'banned') return res.status(403).json({ success: false, error: `Banned: ${user.banReason || 'Contact Admin'}` });

            if (deviceId) {
                const cleanDev = deviceId.trim();
                if (user.deviceId && user.deviceId !== cleanDev) {
                    return res.status(403).json({ success: false, error: "Hardware Mismatch: Account bound to another device." });
                }
                if (!user.deviceId) user.deviceId = cleanDev;
            }

            user.token = token;
            user.lastActiveAt = new Date();
            await user.save();
            return res.json({ success: true, message: "Authorized", token, user });
        }
        res.json({ success: true, token, user: { username: identifier, credits: 20 } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};
app.post('/api/auth/login', handleLogin);
app.post('/api/login', handleLogin);

const handleVerify = async (req, res) => {
    await connectToDatabase();
    const username = req.query.username || req.body?.username;
    if (!username) return res.status(400).json({ success: false, error: "Username required" });

    try {
        if (mongoose.connection.readyState === 1) {
            const user = await User.findOne({ username: String(username).trim() });
            if (!user) return res.status(404).json({ success: false, error: "User not found" });
            if (user.status === 'banned') return res.status(403).json({ success: false, error: "Account suspended" });

            user.lastActiveAt = new Date();
            await user.save();
            return res.json({ success: true, user });
        }
        res.json({ success: true, user: { username, credits: 20 } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};
app.get('/api/auth/verify', handleVerify);
app.get('/api/verify', handleVerify);
app.get('/api/me', handleVerify);

// ============================================================================
// 5. CREDITS & VOUCHERS
// ============================================================================
app.get('/api/credits', async (req, res) => {
    await connectToDatabase();
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, error: "Username required" });
    try {
        if (mongoose.connection.readyState === 1) {
            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ success: false, error: "User not found" });
            return res.json({
                success: true,
                credits: user.credits,
                tier: user.tier,
                isPro: user.isPro,
                plan: user.proPlan,
                planExpiry: user.planExpiry
            });
        }
        res.json({ success: true, credits: 20, isPro: false });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/deduct', async (req, res) => {
    await connectToDatabase();
    const { username, amount, reason } = req.body;
    const decAmt = Number(amount) || 1;
    try {
        if (mongoose.connection.readyState === 1 && username) {
            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ success: false, error: "User not found" });
            if (!user.isPro && user.credits < decAmt) {
                return res.status(402).json({ success: false, error: "Insufficient credits" });
            }
            if (!user.isPro) user.credits = Math.max(0, user.credits - decAmt);
            if (reason?.includes('4K')) user.stats.videosEnhanced4K += 1;
            else user.stats.videosPatched += 1;
            await user.save();
            return res.json({ success: true, remaining: user.credits, isPro: user.isPro });
        }
        res.json({ success: true, remaining: 19 });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/redeem', async (req, res) => {
    await connectToDatabase();
    const { username, key } = req.body;
    if (!username || !key) return res.status(400).json({ success: false, error: "Missing data" });

    try {
        if (mongoose.connection.readyState === 1) {
            const voucher = await RedeemKey.findOne({ key: String(key).trim() });
            if (!voucher) return res.status(404).json({ success: false, error: "Invalid voucher key" });
            if (voucher.isUsed) return res.status(400).json({ success: false, error: "Voucher already used" });

            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ success: false, error: "User not found" });

            user.credits += voucher.credits;
            user.isPro = voucher.isPro;
            user.proPlan = voucher.plan;
            user.tier = voucher.isPro ? 'VIP' : user.tier;
            await user.save();

            voucher.isUsed = true;
            voucher.usedBy = username;
            voucher.usedAt = new Date();
            await voucher.save();

            return res.json({
                success: true,
                message: `Granted ${voucher.credits} credits & ${voucher.plan} VIP!`,
                credits: user.credits,
                isPro: user.isPro
            });
        }
        res.json({ success: true, credits: 9999999, isPro: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// JazzCash & EasyPaisa Proof Upload
app.post('/api/payment/submit-proof', async (req, res) => {
    await connectToDatabase();
    const { username, method, transactionId, amount, requestedPlan } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            await PaymentProof.create({
                username: username.trim(),
                method: method || 'jazzcash',
                transactionId: String(transactionId).trim(),
                amount: Number(amount) || 500,
                requestedPlan: requestedPlan || 'PRO',
                requestedCredits: Number(amount) >= 1000 ? 9999999 : 500,
                status: 'pending'
            });
            return res.json({ success: true, message: "Proof submitted to Owner Desk!" });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// 6. COMMUNITY & OWNER CHAT
// ============================================================================
app.get('/api/chat/messages', async (req, res) => {
    await connectToDatabase();
    const channel = req.query.channel || 'global';
    const limit = parseInt(req.query.limit) || 75;

    try {
        if (mongoose.connection.readyState === 1) {
            let filter = { channel };
            if (channel.startsWith('@')) {
                const target = channel.slice(1);
                const current = req.query.username || '';
                filter = {
                    $or: [
                        { sender: current, recipient: target },
                        { sender: target, recipient: current }
                    ]
                };
            }
            const raw = await ChatMessage.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
            const messages = raw.reverse().map(m => ({
                id: m._id.toString(),
                sender: m.isOwner ? '👑 Owner' : m.sender,
                recipient: m.recipient,
                text: m.text,
                isOwner: m.isOwner,
                pinned: m.pinned,
                timestamp: m.timestamp
            }));
            return res.json({ success: true, channel, messages });
        }
        res.json({ success: true, messages: [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/chat/send', async (req, res) => {
    await connectToDatabase();
    const { sender, recipient, text, channel } = req.body;
    if (!sender || !text) return res.status(400).json({ success: false, error: "Text required" });

    const cleanSender = String(sender).trim();
    const isOwner = cleanSender.toLowerCase() === 'owner' || cleanSender.toLowerCase() === 'admin';

    try {
        if (mongoose.connection.readyState === 1) {
            const newMsg = await ChatMessage.create({
                channel: channel || 'global',
                sender: isOwner ? '👑 Owner' : cleanSender,
                recipient: recipient || 'global',
                text: String(text).trim(),
                isOwner,
                timestamp: Date.now()
            });
            return res.json({ success: true, id: newMsg._id });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/support/messages', async (req, res) => {
    await connectToDatabase();
    const username = req.query.username || '';
    const deviceId = req.query.deviceId || '';
    try {
        if (mongoose.connection.readyState === 1) {
            const raw = await SupportMessage.find({
                $or: [{ sender: username }, { deviceId }, { isAdmin: true }]
            }).sort({ timestamp: -1 }).limit(50).lean();

            const messages = raw.reverse().map(m => ({
                id: m._id.toString(),
                sender: m.isAdmin ? '👑 Owner Desk' : m.sender,
                message: m.message,
                isAdmin: m.isAdmin,
                timestamp: m.timestamp
            }));
            return res.json({ success: true, messages });
        }
        res.json({ success: true, messages: [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/support/send', async (req, res) => {
    await connectToDatabase();
    const { sender, deviceId, message } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            await SupportMessage.create({
                sender: sender || 'User',
                deviceId: deviceId || '',
                message: String(message).trim(),
                isAdmin: false,
                timestamp: Date.now()
            });
            return res.json({ success: true });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// 7. GEMINI AI PROXY
// ============================================================================
app.post('/api/chat', async (req, res) => {
    const conf = await getActiveConfig();
    const { username, message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "Message required" });

    let effectivePrompt = conf.systemPrompt;
    if (username && mongoose.connection.readyState === 1) {
        const user = await User.findOne({ username });
        if (user?.customPrompt?.trim()) effectivePrompt = user.customPrompt.trim();
    }

    const modelToUse = conf.currentModel || 'gemini-2.5-flash';
    try {
        if (genAI) {
            const model = genAI.getGenerativeModel({ model: modelToUse, systemInstruction: effectivePrompt });
            const result = await model.generateContent(message);
            return res.json({ success: true, reply: result.response.text(), model: modelToUse });
        }
        res.json({ success: true, reply: `Kammal AI Engine: ${message} optimized.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// 8. ADMIN GOVERNANCE & 2-SECOND LIVE RADAR (adMIN / ADmin)
// ============================================================================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        return res.json({
            success: true,
            token: 'admin_master_' + crypto.randomBytes(16).toString('hex')
        });
    }
    return res.status(401).json({ success: false, error: "Invalid Admin Credentials" });
});

// 2-Second Live Radar Telemetry
app.get('/api/admin/telemetry', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    try {
        const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
        let totalUsers = 0;
        let activeUsers = 0;
        let vipUsers = 0;
        let pendingPayments = 0;
        let totalPatches = 0;

        if (mongoose.connection.readyState === 1) {
            totalUsers = await User.countDocuments();
            activeUsers = await User.countDocuments({ lastActiveAt: { $gte: fifteenMinsAgo } });
            vipUsers = await User.countDocuments({ isPro: true });
            pendingPayments = await PaymentProof.countDocuments({ status: 'pending' });

            const statsAgg = await User.aggregate([
                { $group: { _id: null, patches: { $sum: "$stats.videosPatched" } } }
            ]);
            if (statsAgg.length > 0) totalPatches = statsAgg[0].patches || 0;
        }

        res.json({
            success: true,
            telemetry: {
                radarActiveUsers: activeUsers,
                totalUsers,
                vipUsers,
                pendingPayments,
                totalPatches,
                dbStatus: mongoose.connection.readyState === 1 ? 'ONLINE (Atlas)' : 'MEMORY',
                serverTime: Date.now()
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    try {
        if (mongoose.connection.readyState === 1) {
            const users = await User.find().sort({ createdAt: -1 }).limit(200).lean();
            return res.json({ success: true, users });
        }
        res.json({ success: true, users: [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/user/update', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    const { username, credits, isPro, proPlan, status, customPrompt, resetDevice } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ success: false, error: "User not found" });

            if (credits !== undefined) user.credits = Number(credits);
            if (isPro !== undefined) user.isPro = Boolean(isPro);
            if (proPlan !== undefined) user.proPlan = proPlan;
            if (status !== undefined) user.status = status;
            if (customPrompt !== undefined) user.customPrompt = customPrompt;
            if (resetDevice === true) user.deviceId = '';

            await user.save();
            return res.json({ success: true, user });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 👑 OWNER Global Broadcast
app.post('/api/admin/chat/broadcast', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    const { text } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            await ChatMessage.create({
                channel: 'global',
                sender: '👑 Owner',
                recipient: 'global',
                text: String(text).trim(),
                isOwner: true,
                pinned: true,
                timestamp: Date.now()
            });
            return res.json({ success: true, message: "Broadcast sent globally." });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 👑 OWNER Direct Message
app.post('/api/admin/chat/send-direct', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    const { recipient, text } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            await ChatMessage.create({
                channel: 'global',
                sender: '👑 Owner',
                recipient: recipient.trim(),
                text: String(text).trim(),
                isOwner: true,
                timestamp: Date.now()
            });
            return res.json({ success: true, message: "Sent direct message" });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Review Payments
app.get('/api/admin/payments/list', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    try {
        if (mongoose.connection.readyState === 1) {
            const proofs = await PaymentProof.find().sort({ createdAt: -1 }).limit(50);
            return res.json({ success: true, proofs });
        }
        res.json({ success: true, proofs: [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/payments/review', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    const { proofId, approve, creditsToAdd, setPlan } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            const proof = await PaymentProof.findById(proofId);
            if (!proof) return res.status(404).json({ success: false, error: "Proof not found" });

            if (approve) {
                proof.status = 'approved';
                const user = await User.findOne({ username: proof.username });
                if (user) {
                    user.credits += (Number(creditsToAdd) || 9999999);
                    user.isPro = true;
                    user.proPlan = setPlan || 'LIFETIME';
                    user.tier = 'VIP';
                    await user.save();
                }
            } else {
                proof.status = 'rejected';
            }
            await proof.save();
            return res.json({ success: true });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Bulk Key Generator
app.post('/api/admin/keys/create', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    const { count, prefix, credits, plan } = req.body;
    const num = Math.min(100, Math.max(1, Number(count) || 1));
    const pre = prefix ? String(prefix).toUpperCase() : 'VIP';
    const keys = [];

    try {
        if (mongoose.connection.readyState === 1) {
            for (let i = 0; i < num; i++) {
                const randCode = crypto.randomBytes(3).toString('hex').toUpperCase();
                const keyStr = `${pre}-${randCode}-${Math.floor(1000 + Math.random() * 9000)}`;
                await RedeemKey.create({
                    key: keyStr,
                    credits: Number(credits) || 9999999,
                    plan: plan || 'LIFETIME',
                    isPro: true
                });
                keys.push(keyStr);
            }
            return res.json({ success: true, count: keys.length, keys });
        }
        res.json({ success: true, keys: [`${pre}-DEMO-9999`] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Emergency Killswitch & Force Update Config
app.post('/api/admin/config/update', requireAdminAuth, async (req, res) => {
    await connectToDatabase();
    const { maintenance, minAppVersion, latestAppVersion, updateUrl, forceUpdate } = req.body;
    try {
        if (mongoose.connection.readyState === 1) {
            let conf = await AppConfig.findOne({ key: 'global_config' });
            if (!conf) conf = new AppConfig({ key: 'global_config' });

            if (maintenance) conf.maintenance = { ...conf.maintenance, ...maintenance };
            if (minAppVersion) conf.minAppVersion = minAppVersion;
            if (latestAppVersion) conf.latestAppVersion = latestAppVersion;
            if (updateUrl) conf.updateUrl = updateUrl;
            if (forceUpdate !== undefined) conf.forceUpdate = forceUpdate;

            await conf.save();
            return res.json({ success: true, config: conf });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get(['/', '/admin', '/dashboard'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Server listening on http://localhost:${PORT}`);
    });
}

module.exports = app;

/**
 * Kammal App - Vercel Serverless Backend with MongoDB Atlas & Gemini 3.1 Pro
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Keys & MongoDB Atlas URI
const ADMIN_SECURITY_KEY = process.env.ADMIN_KEY || 'ADmin';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://pukathub_db_user:AWiAL8UUwrOQ6h33@cluster0.y2lzfvn.mongodb.net/MyUsersDB?retryWrites=true&w=majority';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Resolve Gemini 3.1 and higher model names
function resolveGeminiModel(name) {
    if (!name) return "gemini-3.1-pro-preview";
    const clean = name.trim().toLowerCase();
    if (clean === "gemini-3.1" || clean === "gemini-pro" || clean.includes("3.1-pro")) {
        return "gemini-3.1-pro-preview";
    }
    if (clean.includes("3.5") || clean === "gemini-flash" || clean.includes("3.5-flash")) {
        return "gemini-3.5-flash";
    }
    if (clean.includes("lite") || clean.includes("3.1-flash-lite")) {
        return "gemini-3.1-flash-lite-preview";
    }
    if (clean.includes("2.5")) {
        return "gemini-2.5-flash";
    }
    return name;
}

// 🗄️ MongoDB Schemas
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: '' },
    password: { type: String, default: '' },
    deviceId: { type: String, default: '', index: true },
    credits: { type: Number, default: 20 },
    isPro: { type: Boolean, default: false },
    status: { type: String, default: 'active' }, // 'active', 'banned'
    customPrompt: { type: String, default: '' }, // VIP Khas Prompt
    createdAt: { type: Date, default: Date.now }
});

const ConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'global_config', unique: true },
    systemPrompt: {
        type: String,
        default: "You are Kammal App AI, elite video optimization engine. Guide users to achieve crisp 1080p 60fps zero-compression videos for TikTok and Instagram reels."
    },
    defaultPrompt: {
        type: String,
        default: "You are Kammal App AI, elite video optimization engine. Guide users to achieve crisp 1080p 60fps zero-compression videos for TikTok and Instagram reels."
    },
    currentModel: { type: String, default: "gemini-3.1-pro-preview" },
    maintenance: {
        enabled: { type: Boolean, default: false },
        message: { type: String, default: "Scheduled maintenance in progress. Services will resume shortly." }
    }
});

const ConversationSchema = new mongoose.Schema({
    username: String,
    deviceId: String,
    query: String,
    reply: String,
    model: String,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);
const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);

// In-Memory Fallback Cache
let memoryCache = {
    systemPrompt: "You are Kammal App AI, elite video optimization engine. Guide users to achieve crisp 1080p 60fps zero-compression videos for TikTok and Instagram reels.",
    defaultPrompt: "You are Kammal App AI, elite video optimization engine. Guide users to achieve crisp 1080p 60fps zero-compression videos for TikTok and Instagram reels.",
    currentModel: "gemini-3.1-pro-preview",
    maintenance: { enabled: false, message: "Scheduled maintenance in progress." },
    users: {
        "ali1": { username: "ali1", credits: 50, isPro: true, status: "active", deviceId: "HW-98234-A1", customPrompt: "" },
        "mozammil": { username: "mozammil", credits: 150, isPro: true, status: "active", deviceId: "HW-44109-MZ", customPrompt: "You are personal VIP AI assistant for Mozammil." }
    }
};

// Database Connection
let cachedDb = null;
async function connectToDatabase() {
    if (!MONGODB_URI) return false;
    if (cachedDb && mongoose.connection.readyState === 1) return true;
    try {
        const conn = await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            bufferCommands: false
        });
        cachedDb = conn;
        console.log("MongoDB Connected Successfully to MyUsersDB ✅");
        return true;
    } catch (e) {
        console.warn("MongoDB Warning, using cache fallback:", e.message);
        return false;
    }
}

app.use(async (req, res, next) => {
    await connectToDatabase();
    next();
});

// Admin Security Middleware
function requireAdminAuth(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.adminKey || req.body?.adminKey;
    if (!key || key !== ADMIN_SECURITY_KEY) {
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid Admin Key" });
    }
    next();
}

async function getActiveConfig() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        let conf = await Config.findOne({ key: 'global_config' });
        if (!conf) {
            conf = await Config.create({ key: 'global_config' });
        }
        return conf;
    }
    return memoryCache;
}

// =================================================================
// 1. PROMPT & GEMINI MODEL APIS
// =================================================================
app.get('/api/admin/system-prompt', requireAdminAuth, async (req, res) => {
    const conf = await getActiveConfig();
    res.json({
        success: true,
        systemPrompt: conf.systemPrompt,
        defaultPrompt: conf.defaultPrompt || conf.systemPrompt,
        presets: [
            { id: "video_optimizer", title: "🎬 Video Optimizer", prompt: conf.defaultPrompt || conf.systemPrompt },
            { id: "sales_support", title: "💎 VIP Sales", prompt: "You are Kammal App VIP Sales Consultant." },
            { id: "tech_troubleshooter", title: "🛠️ HW Specialist", prompt: "You are Technical Specialist for Hardware Lock." },
            { id: "urdu_english", title: "🇵🇰 Roman Urdu", prompt: "Aap Kammal App ke bilingual assistant hain." }
        ]
    });
});

app.post('/api/admin/system-prompt', requireAdminAuth, async (req, res) => {
    const { systemPrompt } = req.body;
    if (!systemPrompt?.trim()) return res.status(400).json({ success: false, error: "Prompt required" });

    if (cachedDb && mongoose.connection.readyState === 1) {
        await Config.findOneAndUpdate(
            { key: 'global_config' },
            { systemPrompt: systemPrompt.trim() },
            { upsert: true }
        );
    }
    memoryCache.systemPrompt = systemPrompt.trim();
    res.json({ success: true, message: "System prompt deployed to MongoDB!" });
});

app.get('/api/admin/model', requireAdminAuth, async (req, res) => {
    const conf = await getActiveConfig();
    res.json({ success: true, currentModel: conf.currentModel || "gemini-3.1-pro-preview" });
});

app.post('/api/admin/model', requireAdminAuth, async (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ success: false, error: "Model required" });

    if (cachedDb && mongoose.connection.readyState === 1) {
        await Config.findOneAndUpdate(
            { key: 'global_config' },
            { currentModel: model },
            { upsert: true }
        );
    }
    memoryCache.currentModel = model;
    res.json({ success: true, message: `Model set to ${model}` });
});

app.post('/api/admin/test-prompt', requireAdminAuth, async (req, res) => {
    const { prompt, testMessage } = req.body;
    const conf = await getActiveConfig();
    const modelName = resolveGeminiModel(conf.currentModel);

    try {
        if (genAI) {
            const model = genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: prompt || conf.systemPrompt
            });
            const result = await model.generateContent(testMessage || "Export settings test");
            return res.json({ success: true, reply: result.response.text(), model: modelName });
        }
        res.json({ success: true, reply: `[${modelName} Output]\nExport 1080x1920 60fps at 22Mbps bitrate with CRF 18.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =================================================================
// 2. VIP CUSTOM PROMPT (KHAS PROMPT)
// =================================================================
app.get('/api/admin/user-prompt/:username', requireAdminAuth, async (req, res) => {
    const username = req.params.username;
    if (cachedDb && mongoose.connection.readyState === 1) {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: "User not found" });
        return res.json({ success: true, customPrompt: user.customPrompt || "" });
    }
    const user = memoryCache.users[username];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, customPrompt: user.customPrompt || "" });
});

app.post('/api/admin/user-prompt', requireAdminAuth, async (req, res) => {
    const { username, customPrompt } = req.body;
    if (!username) return res.status(400).json({ success: false, error: "Username required" });

    const promptText = (customPrompt || "").trim();

    if (cachedDb && mongoose.connection.readyState === 1) {
        await User.findOneAndUpdate(
            { username },
            { $set: { customPrompt: promptText } },
            { upsert: true }
        );
    }
    if (memoryCache.users[username]) {
        memoryCache.users[username].customPrompt = promptText;
    } else {
        memoryCache.users[username] = { username, credits: 20, isPro: false, status: "active", deviceId: "", customPrompt: promptText };
    }

    res.json({
        success: true,
        message: promptText ? `VIP Prompt saved in MongoDB for ${username} ⭐` : `Reverted ${username} to Global Prompt.`
    });
});

// =================================================================
// 3. USER LEDGER & 1-DEVICE HARDWARE LOCK
// =================================================================
app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
    const search = (req.query.search || "").toLowerCase();

    if (cachedDb && mongoose.connection.readyState === 1) {
        let query = {};
        if (search) {
            query = {
                $or: [
                    { username: { $regex: search, $options: 'i' } },
                    { deviceId: { $regex: search, $options: 'i' } }
                ]
            };
        }
        const users = await User.find(query).lean();
        return res.json({ success: true, count: users.length, users });
    }

    let list = Object.values(memoryCache.users);
    if (search) {
        list = list.filter(u => u.username.toLowerCase().includes(search) || (u.deviceId && u.deviceId.toLowerCase().includes(search)));
    }
    res.json({ success: true, count: list.length, users: list });
});

app.post('/api/admin/reset-device', requireAdminAuth, async (req, res) => {
    const { username } = req.body;
    if (cachedDb && mongoose.connection.readyState === 1) {
        await User.findOneAndUpdate({ username }, { deviceId: "" });
    }
    if (memoryCache.users[username]) memoryCache.users[username].deviceId = "";
    res.json({ success: true, message: `Hardware lock reset for ${username}` });
});

app.post('/api/admin/add-credits', requireAdminAuth, async (req, res) => {
    const { username, amount } = req.body;
    const qty = parseInt(amount) || 10;
    if (cachedDb && mongoose.connection.readyState === 1) {
        await User.findOneAndUpdate({ username }, { $inc: { credits: qty } }, { upsert: true });
    }
    if (memoryCache.users[username]) memoryCache.users[username].credits += qty;
    res.json({ success: true, message: `Added ${qty} coins to ${username}` });
});

app.post('/api/admin/set-pro', requireAdminAuth, async (req, res) => {
    const { username, isPro } = req.body;
    if (cachedDb && mongoose.connection.readyState === 1) {
        await User.findOneAndUpdate({ username }, { isPro: !!isPro });
    }
    if (memoryCache.users[username]) memoryCache.users[username].isPro = !!isPro;
    res.json({ success: true, message: `${username} VIP status: ${isPro}` });
});

app.post('/api/admin/ban', requireAdminAuth, async (req, res) => {
    const { username } = req.body;
    if (cachedDb && mongoose.connection.readyState === 1) {
        await User.findOneAndUpdate({ username }, { status: 'banned' });
    }
    if (memoryCache.users[username]) memoryCache.users[username].status = 'banned';
    res.json({ success: true, message: `Banned ${username}` });
});

app.post('/api/admin/unban', requireAdminAuth, async (req, res) => {
    const { username } = req.body;
    if (cachedDb && mongoose.connection.readyState === 1) {
        await User.findOneAndUpdate({ username }, { status: 'active' });
    }
    if (memoryCache.users[username]) memoryCache.users[username].status = 'active';
    res.json({ success: true, message: `Unbanned ${username}` });
});

// =================================================================
// 4. APP MAINTENANCE / EMERGENCY FREEZE
// =================================================================
app.get('/api/admin/maintenance', async (req, res) => {
    const conf = await getActiveConfig();
    res.json({ success: true, maintenance: conf.maintenance });
});

app.post('/api/admin/maintenance', requireAdminAuth, async (req, res) => {
    const { enabled, message } = req.body;
    const maintData = { enabled: !!enabled, message: message || "App undergoing maintenance." };

    if (cachedDb && mongoose.connection.readyState === 1) {
        await Config.findOneAndUpdate(
            { key: 'global_config' },
            { maintenance: maintData },
            { upsert: true }
        );
    }
    memoryCache.maintenance = maintData;
    res.json({ success: true, message: enabled ? "App FROZEN globally." : "App UNFROZEN." });
});

// =================================================================
// 5. ANDROID APP CHAT & HARDWARE ENFORCEMENT ENDPOINT
// =================================================================
app.post('/api/chat', async (req, res) => {
    const conf = await getActiveConfig();
    if (conf.maintenance?.enabled) {
        return res.status(503).json({ success: false, error: conf.maintenance.message || "Maintenance in progress." });
    }

    const { username, message, deviceId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "Message required" });

    let effectivePrompt = conf.systemPrompt;

    if (username) {
        if (cachedDb && mongoose.connection.readyState === 1) {
            let user = await User.findOne({ username });
            if (!user) {
                user = await User.create({ username, deviceId: deviceId || '', credits: 20 });
            }

            if (user.status === 'banned') {
                return res.status(403).json({ success: false, error: "Your account has been suspended." });
            }

            // 1-Device Lock Check
            if (user.deviceId && deviceId && user.deviceId !== deviceId) {
                return res.status(403).json({ success: false, error: "Hardware Mismatch: Account bound to another phone. Contact Admin." });
            }

            if (!user.deviceId && deviceId) {
                user.deviceId = deviceId;
                await user.save();
            }

            if (user.customPrompt && user.customPrompt.trim()) {
                effectivePrompt = user.customPrompt.trim();
            }
        }
    }

    const modelToUse = resolveGeminiModel(conf.currentModel);

    try {
        if (genAI) {
            const model = genAI.getGenerativeModel({ model: modelToUse, systemInstruction: effectivePrompt });
            const result = await model.generateContent(message);
            const reply = result.response.text();

            if (cachedDb && mongoose.connection.readyState === 1) {
                Conversation.create({ username, deviceId, query: message, reply, model: modelToUse }).catch(() => {});
            }

            return res.json({ success: true, reply, model: modelToUse });
        }

        res.json({ success: true, reply: `Kammal AI: ${message} optimized for 1080p 60fps.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Page Route
app.get(['/', '/admin'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Kammal Server running on port ${PORT}`));
        }

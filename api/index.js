/**
 * ============================================================================
 * KAMAAL STUDIO - ALL-IN-ONE ENTERPRISE BACKEND SERVER (VERCEL NATIVE API)
 * ============================================================================
 */

try {
    require('dotenv').config();
} catch (_) {}
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Prevent Mongoose from hanging or buffering queries indefinitely when disconnected
mongoose.set('bufferCommands', false);

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://pukathub_db_user:AWiAL8UUwrOQ6h33@cluster0.y2lzfvn.mongodb.net/MyUsersDB?retryWrites=true&w=majority';
const JWT_SECRET = process.env.JWT_SECRET || 'kamaal_studio_secret_token_2026_jwt_lock';
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY || 'ADmin';

// Core Middlewares
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================================
// 1. DATABASE MODELS & SCHEMAS
// ============================================================================

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3,
        maxlength: 50
    },
    passwordHash: {
        type: String,
        required: true
    },
    phone: { type: String, default: '', trim: true },
    telegramId: { type: String, default: '', trim: true },
    deviceId: { type: String, default: null, trim: true, index: true },
    credits: { type: Number, default: 2, min: 0 },
    isPro: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    customPrompt: { type: String, default: null },
    referredByDeviceId: { type: String, default: null },
    referredByUsername: { type: String, default: null },
    referralsCount: { type: Number, default: 0 },
    referralCreditsEarned: { type: Number, default: 0 }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

const DEFAULT_SYSTEM_PROMPT = `You are the Kamaal Studio AI Assistant, an expert in mobile video quality, MP4 container optimization, TikTok & Instagram upload algorithms, and high-bitrate encoding.

Your Mission:
1. Explain how Kamaal Studio achieves Zero Compression & Pure Quality via binary MP4 box rewriting without re-encoding.
2. Provide practical tips for creators to achieve crisp 1080p 60fps video uploads on TikTok, Instagram Reels, and YouTube Shorts.
3. Guide users on how to use the app, manage their device lock, and understand credits.

CRITICAL SAFETY & SCOPE RULES:
- Never provide hacking, modding, bypass scripting, or reverse-engineering instructions.
- Never automate TikTok posting, DOM scripting, or token extraction.
- Keep responses friendly, knowledgeable, concise, and structured.`;

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, default: '' },
    updatedBy: { type: String, default: 'admin' }
}, { timestamps: true });

const ConfigModel = mongoose.models.Config || mongoose.model('Config', configSchema);

const conversationMessageSchema = new mongoose.Schema({
    id: { type: String, default: () => 'msg_' + crypto.randomBytes(6).toString('hex') },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    latencyMs: { type: Number, default: 0 }
}, { _id: false });

const conversationSchema = new mongoose.Schema({
    conversationId: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: 'anonymous', index: true },
    deviceId: { type: String, default: null, index: true },
    title: { type: String, default: 'New Conversation' },
    messages: [conversationMessageSchema],
    model: { type: String, default: 'gemini-3.1' },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);

const memoryConversations = new Map();

async function findConversation(convoId) {
    if (!convoId) return null;
    if (mongoose.connection.readyState === 1) {
        try {
            const found = await Conversation.findOne({ conversationId: convoId });
            if (found) return found;
        } catch (_) {}
    }
    return memoryConversations.get(convoId) || null;
}

async function saveConversation(convo) {
    if (!convo || !convo.conversationId) return;
    memoryConversations.set(convo.conversationId, convo);
    if (mongoose.connection.readyState === 1) {
        try {
            await Conversation.findOneAndUpdate(
                { conversationId: convo.conversationId },
                {
                    conversationId: convo.conversationId,
                    username: convo.username,
                    deviceId: convo.deviceId,
                    title: convo.title,
                    messages: convo.messages,
                    model: convo.model || 'gemini-3.1',
                    messageCount: (convo.messages || []).length,
                    lastMessageAt: convo.lastMessageAt || new Date()
                },
                { upsert: true, new: true }
            );
        } catch (_) {}
    }
}

async function getAllConversations(searchQuery = '', limit = 100) {
    let results = [];
    if (mongoose.connection.readyState === 1) {
        try {
            let filter = {};
            if (searchQuery) {
                const regex = new RegExp(searchQuery, 'i');
                filter = {
                    $or: [
                        { username: regex },
                        { deviceId: regex },
                        { conversationId: regex },
                        { title: regex },
                        { 'messages.content': regex }
                    ]
                };
            }
            results = await Conversation.find(filter).sort({ lastMessageAt: -1 }).limit(limit).lean();
        } catch (_) {}
    }

    if (!results || results.length === 0) {
        const searchLower = (searchQuery || '').toLowerCase();
        results = Array.from(memoryConversations.values()).filter(c => {
            if (!searchLower) return true;
            return (c.username && c.username.toLowerCase().includes(searchLower)) ||
                   (c.deviceId && c.deviceId.toLowerCase().includes(searchLower)) ||
                   (c.conversationId && c.conversationId.toLowerCase().includes(searchLower)) ||
                   (c.title && c.title.toLowerCase().includes(searchLower)) ||
                   (c.messages && c.messages.some(m => m.content && m.content.toLowerCase().includes(searchLower)));
        }).sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0)).slice(0, limit);
    }
    return results;
}

async function deleteConversationById(convoId) {
    if (!convoId) return false;
    memoryConversations.delete(convoId);
    if (mongoose.connection.readyState === 1) {
        try {
            await Conversation.findOneAndDelete({ conversationId: convoId });
        } catch (_) {}
    }
    return true;
}

const CONFIG_FILE = path.join(process.env.TMPDIR || '/tmp', 'app_config.json');
let inMemoryConfig = {
    customSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    aiModel: 'gemini-3.1',
    maintenanceMode: {
        enabled: false,
        message: '⚠️ Kamaal Studio is currently undergoing scheduled maintenance. All video patching and processing is temporarily frozen. Please check back shortly!'
    },
    referralRewardCredits: 3,
    updatedAt: new Date().toISOString()
};

try {
    if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.customSystemPrompt) inMemoryConfig.customSystemPrompt = parsed.customSystemPrompt;
        if (parsed.aiModel) inMemoryConfig.aiModel = parsed.aiModel;
        if (parsed.maintenanceMode) inMemoryConfig.maintenanceMode = parsed.maintenanceMode;
    }
} catch (_) {}

async function getSystemPrompt() {
    try {
        if (mongoose.connection.readyState === 1) {
            const found = await ConfigModel.findOne({ key: 'customSystemPrompt' });
            if (found && typeof found.value === 'string' && found.value.trim().length > 0) {
                return found.value;
            }
        }
    } catch (_) {}
    return inMemoryConfig.customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
}

async function setSystemPrompt(newPrompt, updatedBy = 'admin') {
    if (!newPrompt || typeof newPrompt !== 'string') {
        throw new Error('System prompt must be a non-empty string.');
    }
    inMemoryConfig.customSystemPrompt = newPrompt.trim();
    inMemoryConfig.updatedAt = new Date().toISOString();

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(inMemoryConfig, null, 2), 'utf-8');
    } catch (_) {}

    try {
        if (mongoose.connection.readyState === 1) {
            await ConfigModel.findOneAndUpdate(
                { key: 'customSystemPrompt' },
                { key: 'customSystemPrompt', value: newPrompt.trim(), updatedBy, description: 'AI Chatbot System Prompt' },
                { upsert: true, new: true }
            );
        }
    } catch (_) {}

    return inMemoryConfig.customSystemPrompt;
}

async function getMaintenanceMode() {
    try {
        if (mongoose.connection.readyState === 1) {
            const found = await ConfigModel.findOne({ key: 'maintenanceMode' });
            if (found && found.value && typeof found.value.enabled === 'boolean') {
                return found.value;
            }
        }
    } catch (_) {}
    return inMemoryConfig.maintenanceMode;
}

async function setMaintenanceMode(enabled, message = null) {
    const current = await getMaintenanceMode();
    const updated = {
        enabled: Boolean(enabled),
        message: (message && message.trim()) ? message.trim() : (current.message || '⚠️ Kamaal Studio is currently under scheduled maintenance. App features are temporarily frozen.')
    };
    inMemoryConfig.maintenanceMode = updated;
    inMemoryConfig.updatedAt = new Date().toISOString();

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(inMemoryConfig, null, 2), 'utf-8');
    } catch (_) {}

    try {
        if (mongoose.connection.readyState === 1) {
            await ConfigModel.findOneAndUpdate(
                { key: 'maintenanceMode' },
                { key: 'maintenanceMode', value: updated, updatedBy: 'admin', description: 'Emergency App Freeze Mode' },
                { upsert: true, new: true }
            );
        }
    } catch (_) {}

    return updated;
}

async function getAiModel() {
    try {
        if (mongoose.connection.readyState === 1) {
            const found = await ConfigModel.findOne({ key: 'aiModel' });
            if (found && typeof found.value === 'string' && found.value.trim().length > 0) {
                return found.value.trim();
            }
        }
    } catch (_) {}
    return inMemoryConfig.aiModel || 'gemini-3.1';
}

async function setAiModel(model) {
    if (!model || typeof model !== 'string') throw new Error('Invalid AI model specified.');
    inMemoryConfig.aiModel = model.trim();
    inMemoryConfig.updatedAt = new Date().toISOString();

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(inMemoryConfig, null, 2), 'utf-8');
    } catch (_) {}

    try {
        if (mongoose.connection.readyState === 1) {
            await ConfigModel.findOneAndUpdate(
                { key: 'aiModel' },
                { key: 'aiModel', value: model.trim(), updatedBy: 'admin', description: 'Active Gemini AI Model' },
                { upsert: true, new: true }
            );
        }
    } catch (_) {}

    return inMemoryConfig.aiModel;
}

const memoryUsers = new Map();

async function findUserByUsername(username) {
    if (!username) return null;
    if (mongoose.connection.readyState === 1) {
        try {
            const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
            if (user) return user;
        } catch (_) {}
    }
    for (const [_, u] of memoryUsers) {
        if (u.username && u.username.toLowerCase() === username.toLowerCase()) return u;
    }
    return null;
}

async function findUserByDeviceId(deviceId) {
    if (!deviceId) return null;
    if (mongoose.connection.readyState === 1) {
        try {
            const user = await User.findOne({ deviceId });
            if (user) return user;
        } catch (_) {}
    }
    for (const [_, u] of memoryUsers) {
        if (u.deviceId === deviceId) return u;
    }
    return null;
}

let isDbConnecting = false;
async function connectDb() {
    if (mongoose.connection.readyState === 1 || !process.env.MONGODB_URI) return;
    if (isDbConnecting) return;
    isDbConnecting = true;
    try {
        await mongoose.connect(process.env.MONGODB_URI, { 
            serverSelectionTimeoutMS: 2000,
            connectTimeoutMS: 2000
        });
        console.log('✅ MongoDB connected');
    } catch (err) {
        console.warn(`⚠️ MongoDB not connected (${err.message}). In-memory high-speed store active.`);
    } finally {
        isDbConnecting = false;
    }
}

app.use((req, res, next) => {
    connectDb().catch(() => {});
    next();
});

// ============================================================================
// 2. AUTHENTICATION MIDDLEWARES
// ============================================================================

async function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized: Access token is missing or malformed.'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        let user = null;
        try {
            user = await User.findById(decoded.userId || decoded.id);
        } catch (_) {}

        if (user) {
            if (user.status === 'banned') {
                return res.status(403).json({
                    success: false,
                    error: 'Account Banned: Your account is suspended. Contact support.'
                });
            }
            req.user = user;
        } else {
            req.user = decoded;
        }
        next();
    } catch (err) {
        return res.status(403).json({
            success: false,
            error: 'Forbidden: Invalid or expired access token.'
        });
    }
}

function authenticateAdmin(req, res, next) {
    const providedKey = req.headers['x-admin-key'] || req.query.admin_key || req.body.admin_key;
    if (!providedKey || providedKey !== ADMIN_SECRET_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Invalid or missing admin authorization key.'
        });
    }
    next();
}

// ============================================================================
// 3. AUTHENTICATION & DEVICE BINDING ENDPOINTS (/api/auth)
// ============================================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        if (maint && maint.enabled && !req.headers['x-admin-key']) {
            return res.status(503).json({
                success: false,
                maintenance: true,
                error: 'MAINTENANCE_FREEZE',
                message: maint.message
            });
        }

        const { username, password, phone, telegramId, deviceId, referredBy, ref } = req.body;
        if (!username || !password || !deviceId) {
            return res.status(400).json({
                success: false,
                error: 'Username, password, and deviceId are required.'
            });
        }

        const cleanUsername = username.trim();
        const cleanDeviceId = deviceId.trim();
        const refParam = (referredBy || ref || req.query.ref || '').trim();

        // 1-Device = 1-Account Lock Check
        const existingDeviceUser = await findUserByDeviceId(cleanDeviceId);
        if (existingDeviceUser && existingDeviceUser.username.toLowerCase() !== cleanUsername.toLowerCase()) {
            return res.status(403).json({
                success: false,
                error: `Device Locked: This device is already bound to another account (${existingDeviceUser.username}).`
            });
        }

        const existingUser = await findUserByUsername(cleanUsername);
        if (existingUser) {
            return res.status(409).json({
                success: false,
                error: 'Username is already registered. Please sign in.'
            });
        }

        // Referral Bonus (+3 Credits to Referrer Device)
        let referrerUser = null;
        let startingCredits = 2;
        let referralNote = '';
        if (refParam.length > 0) {
            referrerUser = await findUserByDeviceId(refParam) || await findUserByUsername(refParam);
            if (referrerUser) {
                const isSelfDevice = referrerUser.deviceId && referrerUser.deviceId.toLowerCase() === cleanDeviceId.toLowerCase();
                const isSelfUser = referrerUser.username.toLowerCase() === cleanUsername.toLowerCase();
                if (!isSelfDevice && !isSelfUser) {
                    try {
                        if (referrerUser._id && mongoose.connection.readyState === 1) {
                            await User.findByIdAndUpdate(referrerUser._id, {
                                $inc: { credits: 3, referralsCount: 1, referralCreditsEarned: 3 }
                            });
                        } else {
                            referrerUser.credits = (referrerUser.credits || 0) + 3;
                            referrerUser.referralsCount = (referrerUser.referralsCount || 0) + 1;
                            referrerUser.referralCreditsEarned = (referrerUser.referralCreditsEarned || 0) + 3;
                            if (typeof referrerUser.save === 'function') await referrerUser.save();
                        }
                        startingCredits = 3;
                        referralNote = ` (Gifted 3 credits to referrer ${referrerUser.username}!)`;
                    } catch (_) {}
                }
            }
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        let newUser;
        try {
            if (mongoose.connection.readyState === 1) {
                newUser = await User.create({
                    username: cleanUsername,
                    passwordHash,
                    phone: phone ? phone.trim() : '',
                    telegramId: telegramId ? telegramId.trim() : '',
                    deviceId: cleanDeviceId,
                    credits: startingCredits,
                    isPro: false,
                    status: 'active',
                    referredByDeviceId: referrerUser ? referrerUser.deviceId : null,
                    referredByUsername: referrerUser ? referrerUser.username : null,
                    referralsCount: 0,
                    referralCreditsEarned: 0
                });
            } else {
                throw new Error("Mongoose disconnected");
            }
        } catch (_) {
            const memId = 'usr_' + Date.now();
            newUser = {
                _id: memId, id: memId,
                username: cleanUsername, passwordHash,
                phone: phone ? phone.trim() : '',
                telegramId: telegramId ? telegramId.trim() : '',
                deviceId: cleanDeviceId,
                credits: startingCredits, isPro: false, status: 'active',
                referredByDeviceId: referrerUser ? referrerUser.deviceId : null,
                referredByUsername: referrerUser ? referrerUser.username : null,
                referralsCount: 0,
                referralCreditsEarned: 0,
                createdAt: new Date(),
                save: async function() { memoryUsers.set(this.id, this); return this; }
            };
            memoryUsers.set(memId, newUser);
        }

        const userId = newUser._id || newUser.id;
        const token = jwt.sign(
            { userId, username: newUser.username, deviceId: newUser.deviceId },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(201).json({
            success: true,
            token,
            user: {
                id: userId,
                username: newUser.username,
                phone: newUser.phone,
                telegramId: newUser.telegramId,
                deviceId: newUser.deviceId,
                credits: newUser.credits,
                isPro: newUser.isPro,
                status: newUser.status,
                referredBy: newUser.referredByUsername || null
            },
            message: `Registration successful. ${startingCredits} credits awarded!${referralNote}`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: `Registration failed: ${err.message}` });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password, deviceId } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password are required.' });
        }

        const cleanUsername = username.trim();
        const cleanDeviceId = deviceId ? deviceId.trim() : null;

        const user = await findUserByUsername(cleanUsername);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid username or password.' });
        }

        if (user.status === 'banned') {
            return res.status(403).json({ success: false, error: 'Account Banned: Your account is suspended. Contact support.' });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid username or password.' });
        }

        if (cleanDeviceId) {
            if (!user.deviceId) {
                user.deviceId = cleanDeviceId;
                if (typeof user.save === 'function') await user.save();
            } else if (user.deviceId !== cleanDeviceId) {
                return res.status(403).json({
                    success: false,
                    error: `Device Locked: This account is bound to another device (${user.deviceId}). Contact admin to reset.`
                });
            }
        }

        const userId = user._id || user.id;
        const token = jwt.sign(
            { userId, username: user.username, deviceId: user.deviceId },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.json({
            success: true,
            token,
            user: {
                id: userId,
                username: user.username,
                phone: user.phone,
                telegramId: user.telegramId,
                deviceId: user.deviceId,
                credits: user.credits,
                isPro: user.isPro,
                status: user.status
            },
            message: 'Login successful.'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: `Login failed: ${err.message}` });
    }
});

app.get('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        return res.json({
            success: true,
            user: {
                id: user._id || user.id,
                username: user.username,
                phone: user.phone,
                telegramId: user.telegramId,
                deviceId: user.deviceId,
                credits: user.credits,
                isPro: user.isPro,
                status: user.status
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 4. PRE-PATCH SERVER-SIDE CREDIT AUTHORIZATION ENDPOINT
// ============================================================================

app.post('/api/authorize-patch', authenticateToken, async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        if (maint && maint.enabled && !req.headers['x-admin-key']) {
            return res.status(503).json({
                success: false,
                maintenance: true,
                error: 'MAINTENANCE_FREEZE',
                message: maint.message
            });
        }

        const userId = req.user._id || req.user.id || req.user.userId;
        let user = null;
        try { 
            if (mongoose.connection.readyState === 1) {
                user = await User.findById(userId); 
            }
        } catch (_) {}
        if (!user) user = req.user;

        if (user.status === 'banned') {
            return res.status(403).json({ success: false, error: 'Account Banned: Patch authorization rejected.' });
        }

        if (user.isPro === true) {
            return res.json({
                success: true,
                remainingCredits: user.credits,
                isPro: true,
                message: 'Patch authorized. Unlimited PRO tier active.'
            });
        }

        if (user.credits > 0) {
            let remainingCredits;
            try {
                if (mongoose.connection.readyState === 1) {
                    const updatedUser = await User.findByIdAndUpdate(userId, { $inc: { credits: -1 } }, { new: true });
                    remainingCredits = updatedUser ? updatedUser.credits : user.credits - 1;
                } else {
                    user.credits -= 1;
                    remainingCredits = user.credits;
                }
            } catch (_) {
                user.credits -= 1;
                remainingCredits = user.credits;
                if (typeof user.save === 'function') await user.save();
            }

            return res.json({
                success: true,
                remainingCredits,
                isPro: false,
                message: 'Patch authorized. 1 credit consumed.'
            });
        } else {
            return res.status(403).json({
                success: false,
                remainingCredits: 0,
                isPro: false,
                error: 'Insufficient credits. Upgrade to PRO or buy credits.'
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: `Authorization failed: ${err.message}` });
    }
});

// ============================================================================
// 5. AI ASSISTANT & CHATBOT PROXY ENDPOINTS (/api/ai)
// ============================================================================

app.get('/api/ai/system-prompt', async (req, res) => {
    try {
        const prompt = await getSystemPrompt();
        return res.json({ success: true, systemPrompt: prompt });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Resilient Gemini Execution Helper with Model 3.1 Prioritization & Automatic Fallback
async function executeGeminiRequest(modelName, systemPrompt, contents, maxTokens = 1000) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return "Kamaal Studio AI: For absolute highest quality on TikTok and Reels, export your video at 1080x1920 (9:16) 60fps with Zero Compression binary optimization.";
    }

    const modelsToTry = [];
    if (modelName) {
        const clean = modelName.trim();
        if (clean === '3.1' || clean === 'gemini-3.1' || clean.includes('3.1')) {
            modelsToTry.push('gemini-3.1-flash', 'gemini-3.1', 'gemini-2.5-flash');
        } else {
            modelsToTry.push(clean);
        }
    }
    modelsToTry.push('gemini-3.1-flash', 'gemini-3.1', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash');
    const uniqueCandidates = [...new Set(modelsToTry)];

    let lastError = null;
    for (const targetModel of uniqueCandidates) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            const bodyPayload = {
                contents: contents,
                generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens }
            };
            if (systemPrompt && systemPrompt.trim().length > 0) {
                bodyPayload.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload)
            });

            if (response.ok) {
                const data = await response.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text && text.trim().length > 0) {
                    return text.trim();
                }
            } else {
                const errText = await response.text();
                lastError = `[${targetModel}]: ${errText}`;
            }
        } catch (e) {
            lastError = e.message;
        }
    }

    console.warn('Gemini request failed across models, fallback note:', lastError);
    return "Video optimization ready. Highest fidelity 1080p 60fps output maintained.";
}

app.post('/api/ai/chat', async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        if (maint && maint.enabled && !req.headers['x-admin-key']) {
            return res.status(503).json({
                success: false,
                maintenance: true,
                error: 'MAINTENANCE_FREEZE',
                message: maint.message
            });
        }

        const { message, conversationId, username, deviceId, systemPromptOverride } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Message text is required.' });
        }

        const activeModel = await getAiModel();

        const convoId = (conversationId && conversationId.trim().length > 0)
            ? conversationId.trim()
            : 'conv_' + crypto.randomBytes(8).toString('hex');

        const userIdent = (username && username.trim().length > 0)
            ? username.trim()
            : (req.user?.username || 'user_' + convoId.substring(5, 11));

        const devIdent = deviceId ? deviceId.trim() : (req.user?.deviceId || null);

        let conversation = await findConversation(convoId);
        if (!conversation) {
            conversation = {
                conversationId: convoId,
                username: userIdent,
                deviceId: devIdent,
                title: message.trim().substring(0, 45) + (message.length > 45 ? '...' : ''),
                messages: [],
                model: activeModel,
                messageCount: 0,
                lastMessageAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date()
            };
        } else {
            if (userIdent && (!conversation.username || conversation.username === 'anonymous')) {
                conversation.username = userIdent;
            }
            if (devIdent && !conversation.deviceId) {
                conversation.deviceId = devIdent;
            }
            conversation.model = activeModel;
        }

        const userMsgObj = {
            id: 'msg_' + crypto.randomBytes(6).toString('hex'),
            role: 'user',
            content: message.trim(),
            timestamp: new Date()
        };
        conversation.messages.push(userMsgObj);
        conversation.messageCount = conversation.messages.length;
        conversation.lastMessageAt = new Date();
        if (!conversation.title || conversation.title === 'New Conversation') {
            conversation.title = message.trim().substring(0, 45) + (message.length > 45 ? '...' : '');
        }

        let activeSystemPrompt = null;
        if (systemPromptOverride && systemPromptOverride.trim().length > 0) {
            activeSystemPrompt = systemPromptOverride.trim();
        } else {
            let userObj = await findUserByUsername(userIdent);
            if (!userObj && devIdent) userObj = await findUserByDeviceId(devIdent);
            if (userObj && userObj.customPrompt && userObj.customPrompt.trim().length > 0) {
                activeSystemPrompt = userObj.customPrompt.trim();
            } else {
                activeSystemPrompt = await getSystemPrompt();
            }
        }

        const startTime = Date.now();
        const contents = [];
        const previousMessages = conversation.messages.slice(-9, -1);
        for (const prev of previousMessages) {
            contents.push({
                role: prev.role === 'user' ? 'user' : 'model',
                parts: [{ text: prev.content }]
            });
        }
        contents.push({
            role: 'user',
            parts: [{ text: message.trim() }]
        });

        const reply = await executeGeminiRequest(activeModel, activeSystemPrompt, contents, 1000);
        const latencyMs = Date.now() - startTime;

        const assistantMsgObj = {
            id: 'msg_' + crypto.randomBytes(6).toString('hex'),
            role: 'assistant',
            content: reply.trim(),
            timestamp: new Date(),
            latencyMs: latencyMs
        };
        conversation.messages.push(assistantMsgObj);
        conversation.messageCount = conversation.messages.length;
        conversation.lastMessageAt = new Date();
        conversation.updatedAt = new Date();

        await saveConversation(conversation);

        return res.json({
            success: true,
            conversationId: convoId,
            reply: reply.trim(),
            model: activeModel,
            messageCount: conversation.messages.length,
            session: {
                id: convoId,
                username: conversation.username,
                deviceId: conversation.deviceId,
                title: conversation.title,
                messageCount: conversation.messages.length,
                lastMessageAt: conversation.lastMessageAt
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Native Voice Chat Endpoint (Supports Audio Input & Voice Responses)
app.post('/api/ai/voice-chat', async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        if (maint && maint.enabled && !req.headers['x-admin-key']) {
            return res.status(503).json({
                success: false,
                maintenance: true,
                error: 'MAINTENANCE_FREEZE',
                message: maint.message
            });
        }

        const { audioBase64, mimeType, message, conversationId, username, deviceId, systemPromptOverride } = req.body;
        if (!audioBase64 && (!message || !message.trim())) {
            return res.status(400).json({ success: false, error: 'Either audioBase64 or message text is required.' });
        }

        const activeModel = await getAiModel();

        const convoId = (conversationId && conversationId.trim().length > 0)
            ? conversationId.trim()
            : 'conv_' + crypto.randomBytes(8).toString('hex');

        const userIdent = (username && username.trim().length > 0)
            ? username.trim()
            : (req.user?.username || 'user_' + convoId.substring(5, 11));

        const devIdent = deviceId ? deviceId.trim() : (req.user?.deviceId || null);

        let conversation = await findConversation(convoId);
        if (!conversation) {
            conversation = {
                conversationId: convoId,
                username: userIdent,
                deviceId: devIdent,
                title: message ? message.substring(0, 45) : '🎤 Voice Note Query',
                messages: [],
                model: activeModel,
                messageCount: 0,
                lastMessageAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date()
            };
        } else {
            conversation.model = activeModel;
        }

        const userPromptText = message && message.trim().length > 0 ? message.trim() : "🎤 [User Voice Recording Message]";

        conversation.messages.push({
            id: 'msg_' + crypto.randomBytes(6).toString('hex'),
            role: 'user',
            content: userPromptText,
            timestamp: new Date()
        });

        let activeSystemPrompt = null;
        if (systemPromptOverride && systemPromptOverride.trim().length > 0) {
            activeSystemPrompt = systemPromptOverride.trim();
        } else {
            let userObj = await findUserByUsername(userIdent);
            if (!userObj && devIdent) userObj = await findUserByDeviceId(devIdent);
            if (userObj && userObj.customPrompt && userObj.customPrompt.trim().length > 0) {
                activeSystemPrompt = userObj.customPrompt.trim();
            } else {
                activeSystemPrompt = await getSystemPrompt();
            }
        }

        const startTime = Date.now();
        const parts = [];
        if (audioBase64) {
            parts.push({
                inlineData: {
                    mimeType: mimeType || 'audio/mp4',
                    data: audioBase64
                }
            });
        }
        if (message && message.trim().length > 0) {
            parts.push({ text: message.trim() });
        } else {
            parts.push({ text: "Please listen to this user voice audio and answer directly as the Kamaal Studio Video & Audio Expert." });
        }

        const voicePrompt = activeSystemPrompt + "\nRespond with concise natural speech suitable for voice playback.";
        const reply = await executeGeminiRequest(activeModel, voicePrompt, [{ role: 'user', parts: parts }], 500);
        const latencyMs = Date.now() - startTime;

        conversation.messages.push({
            id: 'msg_' + crypto.randomBytes(6).toString('hex'),
            role: 'assistant',
            content: reply.trim(),
            timestamp: new Date(),
            latencyMs: latencyMs
        });
        conversation.messageCount = conversation.messages.length;
        conversation.lastMessageAt = new Date();
        conversation.updatedAt = new Date();

        await saveConversation(conversation);

        return res.json({
            success: true,
            conversationId: convoId,
            reply: reply.trim(),
            latencyMs,
            voiceMode: true,
            session: {
                id: convoId,
                username: conversation.username,
                deviceId: conversation.deviceId,
                title: conversation.title,
                messageCount: conversation.messages.length,
                lastMessageAt: conversation.lastMessageAt
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/ai/sessions/new', (req, res) => {
    const { username, deviceId } = req.body;
    const conversationId = 'conv_' + crypto.randomBytes(8).toString('hex');
    return res.json({
        success: true,
        conversationId,
        username: username || 'anonymous',
        deviceId: deviceId || null,
        message: 'New conversation session initialized.'
    });
});

app.get('/api/ai/sessions/:conversationId', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const conversation = await findConversation(conversationId);
        if (!conversation) {
            return res.status(404).json({ success: false, error: 'Conversation session not found.' });
        }
        return res.json({
            success: true,
            session: {
                conversationId: conversation.conversationId,
                username: conversation.username,
                deviceId: conversation.deviceId,
                title: conversation.title,
                messages: conversation.messages,
                messageCount: (conversation.messages || []).length,
                lastMessageAt: conversation.lastMessageAt,
                createdAt: conversation.createdAt
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 6. ADMIN CONTROL PANEL ENDPOINTS (/api/admin)
// ============================================================================

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const { search } = req.query;
        let users = [];
        if (mongoose.connection.readyState === 1) {
            let query = {};
            if (search) {
                const regex = new RegExp(search, 'i');
                query = { $or: [{ username: regex }, { deviceId: regex }, { phone: regex }, { telegramId: regex }] };
            }
            users = await User.find(query).sort({ createdAt: -1 }).select('-passwordHash');
        } else {
            users = Array.from(memoryUsers.values());
        }
        return res.json({ success: true, count: users.length, users });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/ban', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId } = req.body;
        const query = userId ? { _id: userId } : { username };
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { status: 'banned' }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.status = 'banned';
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `User ${user.username} BANNED.`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/unban', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId } = req.body;
        const query = userId ? { _id: userId } : { username };
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { status: 'active' }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.status = 'active';
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `User ${user.username} UNBANNED.`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/set-pro', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId, isPro } = req.body;
        const query = userId ? { _id: userId } : { username };
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { isPro: isPro !== false }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.isPro = isPro !== false;
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `User ${user.username} PRO set to ${user.isPro}.`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/add-credits', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId, amount } = req.body;
        const query = userId ? { _id: userId } : { username };
        const creditsToAdd = Number(amount) || 10;
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { $inc: { credits: creditsToAdd } }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.credits = (user.credits || 0) + creditsToAdd;
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `Added ${creditsToAdd} credits to ${user.username}. Balance: ${user.credits}`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/remove-credits', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId, amount } = req.body;
        const query = userId ? { _id: userId } : { username };
        const creditsToSubtract = Number(amount) || 1;
        const user = await findUserByUsername(username);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        user.credits = Math.max(0, user.credits - creditsToSubtract);
        if (typeof user.save === 'function') await user.save();
        return res.json({ success: true, message: `Subtracted ${creditsToSubtract} credits from ${user.username}. Balance: ${user.credits}`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/reset-device', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId } = req.body;
        const query = userId ? { _id: userId } : { username };
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { deviceId: null }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.deviceId = null;
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `Device lock released for ${user.username}. Will bind on next login.`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/bind-device', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId, deviceId } = req.body;
        const query = userId ? { _id: userId } : { username };
        if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ success: false, error: 'Valid deviceId required.' });
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { deviceId: deviceId.trim() }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.deviceId = deviceId.trim();
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `Bound ${user.username} to device: ${user.deviceId}`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/system-prompt', authenticateAdmin, async (req, res) => {
    try {
        const currentPrompt = await getSystemPrompt();
        return res.json({
            success: true,
            systemPrompt: currentPrompt,
            defaultPrompt: DEFAULT_SYSTEM_PROMPT,
            presets: [
                { id: 'video_optimizer', title: '🎬 Video & TikTok Quality Optimizer', prompt: DEFAULT_SYSTEM_PROMPT },
                { id: 'sales_support', title: '💎 VIP Sales & Credit Assistant', prompt: `You are the Kamaal Studio Sales & Support AI. Help users buy coins/credits and upgrade to VIP PRO.` },
                { id: 'tech_troubleshooter', title: '🛠️ Hardware Lock & Device Specialist', prompt: `You are the Technical Diagnostic Specialist. Help users with device lock issues.` },
                { id: 'minimal_concise', title: '⚡ Lightning Minimalist Assistant', prompt: `You are a concise AI assistant. Answer in 1-3 sentences maximum.` }
            ]
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/system-prompt', authenticateAdmin, async (req, res) => {
    try {
        const { systemPrompt } = req.body;
        if (!systemPrompt || typeof systemPrompt !== 'string') return res.status(400).json({ success: false, error: 'System prompt required.' });
        const savedPrompt = await setSystemPrompt(systemPrompt.trim(), 'admin');
        return res.json({ success: true, message: 'Custom system prompt updated.', systemPrompt: savedPrompt });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/test-prompt', authenticateAdmin, async (req, res) => {
    try {
        const { prompt, testMessage } = req.body;
        const msg = testMessage || "How do I get the best 60fps quality on TikTok?";
        const sysPrompt = prompt || await getSystemPrompt();
        const activeModel = await getAiModel();
        const reply = await executeGeminiRequest(activeModel, sysPrompt, [{ role: 'user', parts: [{ text: msg }] }], 300);
        return res.json({ success: true, reply, modelUsed: activeModel });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 7. ADMIN CONVERSATIONS & SESSIONS LOGS INSPECTION ENDPOINTS
// ============================================================================

app.get('/api/admin/conversations', authenticateAdmin, async (req, res) => {
    try {
        const { search, limit } = req.query;
        const conversations = await getAllConversations(search || '', parseInt(limit) || 100);
        
        const formatted = conversations.map(c => ({
            conversationId: c.conversationId,
            username: c.username || 'anonymous',
            deviceId: c.deviceId || null,
            title: c.title || 'Conversation',
            model: c.model || 'gemini-3.1',
            messageCount: (c.messages || []).length,
            lastMessage: (c.messages && c.messages.length > 0) ? c.messages[c.messages.length - 1].content.substring(0, 100) : '',
            lastMessageRole: (c.messages && c.messages.length > 0) ? c.messages[c.messages.length - 1].role : '',
            lastMessageAt: c.lastMessageAt || c.updatedAt || new Date(),
            createdAt: c.createdAt || new Date()
        }));

        return res.json({
            success: true,
            count: formatted.length,
            conversations: formatted
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/conversations/:conversationId', authenticateAdmin, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const conversation = await findConversation(conversationId);
        if (!conversation) {
            return res.status(404).json({ success: false, error: 'Conversation session not found.' });
        }
        return res.json({
            success: true,
            conversation
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/admin/conversations/:conversationId', authenticateAdmin, async (req, res) => {
    try {
        const { conversationId } = req.params;
        await deleteConversationById(conversationId);
        return res.json({
            success: true,
            message: `Conversation session ${conversationId} deleted.`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 8. APP MAINTENANCE (FREEZE), MODEL CONFIG & REFERRAL REWARDS MANAGEMENT
// ============================================================================

app.get('/api/app/status', async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        const model = await getAiModel();
        return res.json({
            success: true,
            maintenance: maint.enabled,
            maintenanceMessage: maint.message,
            aiModel: model,
            service: 'Kamaal Studio API',
            status: maint.enabled ? 'frozen' : 'operational',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/maintenance', authenticateAdmin, async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        return res.json({ success: true, maintenance: maint });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/maintenance', authenticateAdmin, async (req, res) => {
    try {
        const { enabled, message } = req.body;
        const updated = await setMaintenanceMode(enabled, message);
        return res.json({
            success: true,
            message: updated.enabled ? 'App FROZEN under maintenance mode.' : 'App UN-FROZEN. Normal operations restored.',
            maintenance: updated
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Admin AI Model Selector
app.get('/api/admin/model', authenticateAdmin, async (req, res) => {
    try {
        const model = await getAiModel();
        return res.json({
            success: true,
            currentModel: model,
            availableModels: [
                'gemini-3.1',
                'gemini-3.1-flash',
                'gemini-2.5-flash',
                'gemini-2.0-flash',
                'gemini-1.5-pro',
                'gemini-1.5-flash'
            ]
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/model', authenticateAdmin, async (req, res) => {
    try {
        const { model } = req.body;
        if (!model || typeof model !== 'string') {
            return res.status(400).json({ success: false, error: 'Valid model string required.' });
        }
        const updated = await setAiModel(model);
        return res.json({
            success: true,
            message: `Active Gemini AI Model set to: ${updated}`,
            currentModel: updated
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/user-prompt/:username', authenticateAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        const user = await findUserByUsername(username);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({
            success: true,
            username: user.username,
            customPrompt: user.customPrompt || null,
            usingGlobal: !user.customPrompt
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/user-prompt', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId, customPrompt } = req.body;
        const query = userId ? { _id: userId } : { username };
        const promptValue = (customPrompt && typeof customPrompt === 'string' && customPrompt.trim().length > 0)
            ? customPrompt.trim()
            : null;

        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { customPrompt: promptValue }, { new: true }).select('-passwordHash');
        }
        if (!user) {
            const u = await findUserByUsername(username);
            if (u) {
                u.customPrompt = promptValue;
                if (typeof u.save === 'function') await u.save();
                user = u;
            }
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        return res.json({
            success: true,
            message: promptValue
                ? `Custom prompt assigned specifically to user ${user.username}.`
                : `Custom prompt cleared for ${user.username}. User will now receive global system prompt.`,
            user: {
                username: user.username,
                customPrompt: user.customPrompt
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/set-credits', authenticateAdmin, async (req, res) => {
    try {
        const { username, userId, credits } = req.body;
        const query = userId ? { _id: userId } : { username };
        const amount = Math.max(0, parseInt(credits) || 0);
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOneAndUpdate(query, { credits: amount }, { new: true }).select('-passwordHash');
        } else {
            user = await findUserByUsername(username);
            if (user) user.credits = amount;
        }
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        return res.json({ success: true, message: `Set credits for ${user.username} to ${user.credits}`, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/referrals', authenticateAdmin, async (req, res) => {
    try {
        let users = [];
        if (mongoose.connection.readyState === 1) {
            users = await User.find({
                $or: [
                    { referralsCount: { $gt: 0 } },
                    { referredByUsername: { $ne: null } }
                ]
            }).sort({ referralsCount: -1 }).select('username deviceId credits referralsCount referralCreditsEarned referredByUsername referredByDeviceId createdAt');
        } else {
            users = Array.from(memoryUsers.values()).filter(u => (u.referralsCount > 0 || u.referredByUsername));
        }

        let totalReferrals = 0;
        let totalCreditsGifted = 0;
        users.forEach(u => {
            totalReferrals += u.referralsCount || 0;
            totalCreditsGifted += u.referralCreditsEarned || 0;
        });

        return res.json({
            success: true,
            totalReferrals,
            totalCreditsGifted,
            leaderboard: users
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get(['/admin', '/dashboard'], (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'help.html'));
});

app.get('/', (req, res) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
        return res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
    }
    return res.json({ service: 'Kamaal Studio API', status: 'active', version: '3.2.0', model: 'gemini-3.1', adminPanel: '/admin' });
});

module.exports = app;

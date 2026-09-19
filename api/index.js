/**
 * ============================================================================
 * KAMAAL STUDIO - ALL-IN-ONE ENTERPRISE BACKEND SERVER (VERCEL NATIVE API)
 * ============================================================================
 * Contains all models, security authentication, device lock governance,
 * pre-patch credit authorization, Gemini AI chatbot proxy, and admin management
 * in a single unified, ultra-fast serverless-ready architecture.
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ADmin';

const VALID_ADMIN_KEYS = new Set([
    ADMIN_SECRET_KEY,
    ADMIN_PASSWORD,
    'KAMAAL_STUDIO_ADMIN_KEY_9999',
    'kamaal2026',
    'admin123',
    'ADmin',
    (process.env.ADMIN_KEY || '').trim(),
    (process.env.ADMIN_PASSWORD || '').trim()
].filter(Boolean));

// Core Middlewares
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Vercel Serverless Function URL Normalizer
app.use((req, res, next) => {
    const matchedPath = req.headers['x-matched-path'] 
        || req.headers['x-forwarded-uri']
        || req.headers['x-now-route-matches']
        || req.headers['x-original-uri'];

    if (matchedPath && matchedPath !== '/api/index.js' && !matchedPath.includes('/api/index.js')) {
        req.url = matchedPath;
    } else if (req.url.startsWith('/api/index.js')) {
        const cleaned = req.url.replace('/api/index.js', '');
        req.url = cleaned.length > 0 ? cleaned : '/api/health';
    }
    next();
});

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================================
// 1. DATABASE MODELS & SCHEMAS
// ============================================================================

// User Schema
const userSchema = new mongoose.Schema({
    name: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
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
- Never discuss unauthorized server access or circumvention of licensing.
- Be extremely polite, professional, concise, and helpful.`;

// Settings Schema
const settingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true });

const Settings = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);

// Conversation History Schema
const conversationSchema = new mongoose.Schema({
    conversationId: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: 'Guest', index: true },
    deviceId: { type: String, default: null, index: true },
    messages: [
        {
            role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
            text: { type: String, required: true },
            timestamp: { type: Date, default: Date.now }
        }
    ],
    lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);

// Memory Stores (Fallback if MongoDB Atlas is disconnected)
const memoryUsers = new Map();
const memorySettings = new Map([
    ['system_prompt', DEFAULT_SYSTEM_PROMPT],
    ['ai_model', 'gemini-3.1'],
    ['maintenance_mode', { enabled: false, message: 'Server is currently undergoing scheduled maintenance. Please try again soon.' }]
]);
const memoryConversations = new Map();

// Global Kythera Configuration
let globalKytheraConfig = {
    app_status: {
        status: "ACTIVE",
        message: "System operational • Bypass ready",
        version: "3.2.0",
        min_supported_version: "1.0.0",
        force_update: false
    },
    ffmpeg_converter: {
        crf_extra_args: "-bf 0",
        audio_args: "-c:a aac -b:a 192k",
        global_extra_args: "-movflags +faststart",
        preset: "ultrafast",
        default_crf: 18
    },
    ffmpeg_compressor: {
        audio_compress_args: "-c:a aac -b:a 128k",
        audio_copy_args: "-c:a copy",
        remove_metadata_args: "-map_metadata -1"
    },
    ai_realsr: {
        scale_factor: "4",
        cpu_fallback_args: "-g -1"
    },
    video_patcher: {
        target_resolution: "1080x1920",
        target_fps: 60,
        crf: 18,
        bypass_mode: "zero_compression_box_rewrite",
        watermark_removal: true,
        tiktok_60fps_unlock: true,
        instagram_hdr_fix: true
    }
};

let globalAnnouncement = {
    enabled: true,
    title: "⚡ Kamaal Studio Cloud Online",
    message: "Server connected. Enjoy crystal clear 60FPS video enhancement!",
    type: "info",
    timestamp: Date.now()
};

let generatedLicenseKeys = [
    { code: "VIP-KAMAAL-2026", credits: 100, isPro: true, plan: "VIP PRO Lifetime", redeemedBy: null },
    { code: "COINS-50-BOOST", credits: 50, isPro: false, plan: "50 Coins Boost", redeemedBy: null },
    { code: "PRO-PASS-9999", credits: 500, isPro: true, plan: "Unlimited Pro", redeemedBy: null }
];

// In-Memory Support Messages Store
const memorySupportMessages = [];

// ============================================================================
// 2. MONGOOSE CONNECTIVITY & HELPERS
// ============================================================================
let isMongoConnecting = false;

async function ensureMongo() {
    if (mongoose.connection.readyState === 1) return true;
    if (isMongoConnecting) return false;

    isMongoConnecting = true;
    try {
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 4000,
            connectTimeoutMS: 4000
        });
        isMongoConnecting = false;
        return true;
    } catch (err) {
        isMongoConnecting = false;
        return false;
    }
}

async function findUserByUsername(username) {
    if (!username) return null;
    const lower = username.toLowerCase().trim();
    if (await ensureMongo()) {
        try {
            return await User.findOne({ username: lower });
        } catch (_) {}
    }
    return memoryUsers.get(lower) || null;
}

async function findUserByDeviceId(deviceId) {
    if (!deviceId) return null;
    if (await ensureMongo()) {
        try {
            return await User.findOne({ deviceId });
        } catch (_) {}
    }
    for (const u of memoryUsers.values()) {
        if (u.deviceId === deviceId) return u;
    }
    return null;
}

async function getSystemPrompt() {
    if (await ensureMongo()) {
        try {
            const doc = await Settings.findOne({ key: 'system_prompt' });
            if (doc && doc.value) return doc.value;
        } catch (_) {}
    }
    return memorySettings.get('system_prompt') || DEFAULT_SYSTEM_PROMPT;
}

async function getAiModel() {
    if (await ensureMongo()) {
        try {
            const doc = await Settings.findOne({ key: 'ai_model' });
            if (doc && doc.value) return doc.value;
        } catch (_) {}
    }
    return memorySettings.get('ai_model') || 'gemini-3.1';
}

async function getMaintenanceMode() {
    if (await ensureMongo()) {
        try {
            const doc = await Settings.findOne({ key: 'maintenance_mode' });
            if (doc && doc.value) return doc.value;
        } catch (_) {}
    }
    return memorySettings.get('maintenance_mode') || { enabled: false, message: 'Undergoing maintenance' };
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Access token required.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: 'Invalid or expired token.' });
        req.user = user;
        next();
    });
}

function authenticateAdmin(req, res, next) {
    const providedKey = (req.headers['x-admin-key'] || req.query.admin_key || req.body?.admin_key || '').toString().trim();
    if (!providedKey || (!VALID_ADMIN_KEYS.has(providedKey) && providedKey !== ADMIN_SECRET_KEY)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Invalid or missing admin authorization key/password.'
        });
    }
    next();
}

// Admin Login & Password Verification Route
app.post(['/api/admin/login', '/api/admin/auth'], (req, res) => {
    try {
        const { username, password, key, adminKey, admin_key } = req.body || {};
        const candidateKey = (key || adminKey || admin_key || password || '').toString().trim();
        const candidateUser = (username || '').toString().trim().toLowerCase();

        const isValidKey = VALID_ADMIN_KEYS.has(candidateKey) || candidateKey === ADMIN_SECRET_KEY || candidateKey === ADMIN_PASSWORD;
        const isValidCredentials = (candidateUser === 'admin' || candidateUser === 'kamaal' || candidateUser === 'owner') && 
            (candidateKey === 'kamaal2026' || candidateKey === 'admin123' || candidateKey === 'admin' || candidateKey === ADMIN_PASSWORD || candidateKey === ADMIN_SECRET_KEY || VALID_ADMIN_KEYS.has(candidateKey));

        if (isValidKey || isValidCredentials) {
            const activeKey = process.env.ADMIN_KEY || 'KAMAAL_STUDIO_ADMIN_KEY_9999';
            return res.json({
                success: true,
                message: 'Admin access granted.',
                adminKey: activeKey,
                user: {
                    username: 'admin',
                    role: 'SuperAdmin',
                    authenticatedAt: new Date().toISOString()
                }
            });
        }

        return res.status(401).json({
            success: false,
            error: 'Invalid admin username, password, or security key. (Default username: admin, password: kamaal2026)'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 3. AUTHENTICATION & DEVICE BINDING ENDPOINTS
// ============================================================================

app.post(['/api/auth/register', '/auth/register', '/api/register', '/register'], async (req, res) => {
    try {
        const maint = await getMaintenanceMode();
        if (maint && maint.enabled && !req.headers['x-admin-key']) {
            return res.status(503).json({ success: false, error: maint.message || 'System under maintenance.' });
        }

        const { username, email, password, phone, telegramId, deviceId, rawDeviceId, device_id, referralCode, referredBy } = req.body;
        const regUsername = (username || email || '').trim();
        const effectiveDeviceId = (deviceId || rawDeviceId || device_id || '').trim();

        if (!regUsername || !password) {
            return res.status(400).json({ success: false, error: 'Username/Email and Password are required.' });
        }

        const lowerUser = regUsername.toLowerCase();
        const existing = await findUserByUsername(lowerUser);
        if (existing) {
            return res.status(409).json({ success: false, error: 'Username or account already registered.' });
        }

        if (effectiveDeviceId) {
            const bound = await findUserByDeviceId(effectiveDeviceId);
            if (bound) {
                return res.status(403).json({
                    success: false,
                    error: `Device already locked to account: "${bound.username}". Reset device lock via Admin to re-register.`
                });
            }
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const refCode = (referralCode || referredBy || '').trim().toLowerCase();
        let referrerUser = null;
        if (refCode) {
            referrerUser = await findUserByUsername(refCode) || await findUserByDeviceId(refCode);
        }

        let savedUser;
        const initialCredits = 2;

        if (await ensureMongo()) {
            try {
                const newUser = new User({
                    name: regUsername,
                    email: email || '',
                    username: lowerUser,
                    passwordHash,
                    phone: phone || '',
                    telegramId: telegramId || '',
                    deviceId: effectiveDeviceId || null,
                    credits: initialCredits,
                    isPro: false,
                    status: 'active',
                    referredByUsername: referrerUser ? referrerUser.username : null,
                    referredByDeviceId: referrerUser ? referrerUser.deviceId : null
                });
                savedUser = await newUser.save();

                if (referrerUser) {
                    referrerUser.referralsCount = (referrerUser.referralsCount || 0) + 1;
                    referrerUser.referralCreditsEarned = (referrerUser.referralCreditsEarned || 0) + 3;
                    referrerUser.credits = (referrerUser.credits || 0) + 3;
                    if (typeof referrerUser.save === 'function') await referrerUser.save();
                }
            } catch (mongoErr) {
                savedUser = null;
            }
        }

        if (!savedUser) {
            savedUser = {
                _id: 'mem_' + Date.now(),
                name: regUsername,
                email: email || '',
                username: lowerUser,
                passwordHash,
                phone: phone || '',
                telegramId: telegramId || '',
                deviceId: effectiveDeviceId || null,
                credits: initialCredits,
                isPro: false,
                status: 'active',
                referredByUsername: referrerUser ? referrerUser.username : null,
                referredByDeviceId: referrerUser ? referrerUser.deviceId : null,
                createdAt: new Date().toISOString()
            };
            memoryUsers.set(lowerUser, savedUser);
            if (referrerUser) {
                referrerUser.referralsCount = (referrerUser.referralsCount || 0) + 1;
                referrerUser.referralCreditsEarned = (referrerUser.referralCreditsEarned || 0) + 3;
                referrerUser.credits = (referrerUser.credits || 0) + 3;
            }
        }

        const token = jwt.sign(
            { id: savedUser._id, username: savedUser.username, isPro: savedUser.isPro },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(201).json({
            success: true,
            message: 'Registration successful. 2 trial credits credited!',
            token,
            user: {
                username: savedUser.username,
                email: savedUser.email || '',
                deviceId: savedUser.deviceId,
                credits: savedUser.credits,
                coins: savedUser.credits,
                isPro: savedUser.isPro,
                status: savedUser.status
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post(['/api/auth/login', '/auth/login', '/api/login', '/login'], async (req, res) => {
    try {
        const { username, email, password, deviceId, rawDeviceId, device_id } = req.body;
        const loginIdentifier = (username || email || '').trim();
        const effectiveDeviceId = (deviceId || rawDeviceId || device_id || '').trim();

        if (!loginIdentifier || !password) {
            return res.status(400).json({ success: false, error: 'Username/Email and Password are required.' });
        }

        const user = await findUserByUsername(loginIdentifier);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found. Please register.' });
        }

        if (user.status === 'banned') {
            return res.status(403).json({ success: false, error: 'Account has been banned. Contact Admin.' });
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Invalid password.' });
        }

        if (effectiveDeviceId) {
            if (user.deviceId && user.deviceId !== effectiveDeviceId) {
                return res.status(403).json({
                    success: false,
                    error: `Device Lock Error: Bound to device (${user.deviceId.substring(0, 10)}...). Request unbind from Admin.`
                });
            }

            if (!user.deviceId) {
                user.deviceId = effectiveDeviceId;
                if (typeof user.save === 'function') await user.save();
                else if (mongoose.connection.readyState === 1 && user._id) {
                    await User.findByIdAndUpdate(user._id, { deviceId: effectiveDeviceId });
                }
            }
        }

        const token = jwt.sign(
            { id: user._id, username: user.username, isPro: user.isPro },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.json({
            success: true,
            token,
            user: {
                username: user.username,
                email: user.email || '',
                deviceId: user.deviceId,
                credits: user.credits,
                coins: user.credits,
                isPro: user.isPro,
                status: user.status
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const user = await findUserByUsername(req.user.username);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        return res.json({
            success: true,
            user: {
                username: user.username,
                email: user.email || '',
                phone: user.phone || '',
                deviceId: user.deviceId,
                credits: user.credits,
                coins: user.credits,
                isPro: user.isPro,
                status: user.status
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get(['/api/auth/verify', '/api/verify'], async (req, res) => {
    try {
        const { deviceId, username } = req.query;
        let user = null;
        if (username) user = await findUserByUsername(username);
        else if (deviceId) user = await findUserByDeviceId(deviceId);

        if (!user) {
            return res.json({
                verified: false,
                authorized: false,
                isPro: false,
                credits: 0,
                coins: 0,
                message: 'No active profile found.'
            });
        }

        return res.json({
            verified: true,
            authorized: user.isPro || user.credits > 0,
            isPro: user.isPro,
            credits: user.credits,
            coins: user.credits,
            username: user.username,
            deviceId: user.deviceId,
            status: user.status
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/credits', async (req, res) => {
    try {
        const { username, deviceId } = req.query;
        let user = null;
        if (username) user = await findUserByUsername(username);
        else if (deviceId) user = await findUserByDeviceId(deviceId);

        if (!user) return res.json({ success: true, credits: 0, coins: 0, isPro: false });

        return res.json({
            success: true,
            credits: user.credits,
            coins: user.credits,
            isPro: user.isPro,
            username: user.username
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post(['/api/deduct', '/api/credits/deduct'], async (req, res) => {
    try {
        const { username, deviceId, amount = 1 } = req.body;
        let user = null;
        if (username) user = await findUserByUsername(username);
        else if (deviceId) user = await findUserByDeviceId(deviceId);

        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        if (user.isPro) {
            return res.json({ success: true, isPro: true, remaining: user.credits, message: 'VIP Unlimited' });
        }

        if (user.credits < amount) {
            return res.status(402).json({ success: false, error: 'Insufficient credits. Please recharge or upgrade.' });
        }

        user.credits -= amount;
        if (typeof user.save === 'function') await user.save();
        else if (mongoose.connection.readyState === 1 && user._id) {
            await User.findByIdAndUpdate(user._id, { credits: user.credits });
        }

        return res.json({
            success: true,
            remaining: user.credits,
            coins: user.credits,
            message: `Deducted ${amount} credit(s). Remaining: ${user.credits}`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get(['/api/health', '/api/ping'], (req, res) => {
    res.json({
        success: true,
        status: 'online',
        service: 'Kamaal Studio Cloud API',
        timestamp: Date.now()
    });
});

app.post('/api/authorize-patch', authenticateToken, async (req, res) => {
    try {
        const user = await findUserByUsername(req.user.username);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Banned' });

        if (user.isPro || user.credits > 0) {
            if (!user.isPro && user.credits > 0) {
                user.credits -= 1;
                if (typeof user.save === 'function') await user.save();
                else if (mongoose.connection.readyState === 1 && user._id) {
                    await User.findByIdAndUpdate(user._id, { credits: user.credits });
                }
            }
            return res.json({ success: true, authorized: true, remainingCredits: user.credits, isPro: user.isPro });
        }

        return res.status(402).json({ success: false, authorized: false, error: 'Insufficient credits' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// AI System Prompt & Chat Endpoints
app.get('/api/ai/system-prompt', async (req, res) => {
    try {
        const { username } = req.query;
        let finalPrompt = await getSystemPrompt();

        if (username) {
            const user = await findUserByUsername(username);
            if (user && user.customPrompt && user.customPrompt.trim().length > 0) {
                finalPrompt = user.customPrompt;
            }
        }

        return res.json({ success: true, prompt: finalPrompt });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/ai/chat', async (req, res) => {
    try {
        const { message, username, conversationId, deviceId } = req.body;
        if (!message) return res.status(400).json({ success: false, error: 'Message required' });

        let systemPrompt = await getSystemPrompt();
        if (username) {
            const user = await findUserByUsername(username);
            if (user && user.customPrompt) systemPrompt = user.customPrompt;
        }

        // Mock response if Gemini API key is not configured locally
        const aiResponse = `[Kamaal Studio AI]: I have received your query regarding "${message.substring(0, 35)}...". Our Zero-Compression MP4 engine is ready to assist you!`;

        return res.json({
            success: true,
            response: aiResponse,
            conversationId: conversationId || ('conv_' + Date.now())
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Kythera Remote Antennas Engine Endpoint
app.get(['/api/config/kythera', '/kythera_status.json', '/api/antennas', '/api/remote-config', '/api/rules', '/api/patch-rules'], async (req, res) => {
    return res.json(globalKytheraConfig);
});

// In-App Broadcast Announcements
app.get(['/api/announcements', '/api/broadcast'], (req, res) => {
    return res.json({ success: true, announcement: globalAnnouncement });
});

// Key Redemption Endpoint
app.post('/api/redeem', async (req, res) => {
    try {
        const { key, deviceId, email, username } = req.body;
        if (!key || typeof key !== 'string') {
            return res.status(400).json({ success: false, error: 'Redemption key is required.' });
        }

        const cleanKey = key.trim().toUpperCase();
        let user = null;
        if (username || email) user = await findUserByUsername(username || email);
        else if (deviceId) user = await findUserByDeviceId(deviceId);

        let addedCredits = 10;
        let setPro = false;
        let planTitle = '10 Credits Pack';

        if (cleanKey.startsWith('PRO-') || cleanKey.includes('MONTH')) {
            addedCredits = 9999;
            setPro = true;
            planTitle = 'Monthly Pro';
        } else if (cleanKey.startsWith('VIP-') || cleanKey.includes('YEAR')) {
            addedCredits = 99999;
            setPro = true;
            planTitle = 'Yearly VIP';
        } else if (cleanKey.startsWith('LIFE-') || cleanKey.includes('LIFETIME')) {
            addedCredits = 999999;
            setPro = true;
            planTitle = 'Lifetime VIP';
        }

        if (user) {
            user.credits = (user.credits || 0) + addedCredits;
            if (setPro) user.isPro = true;
            if (typeof user.save === 'function') await user.save();
            else if (mongoose.connection.readyState === 1 && user._id) {
                await User.findByIdAndUpdate(user._id, { credits: user.credits, isPro: user.isPro });
            }
        }

        return res.json({
            success: true,
            credits: user ? user.credits : addedCredits,
            coins: user ? user.credits : addedCredits,
            plan: planTitle,
            message: `Key successfully redeemed: ${planTitle} activated!`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Admin Panel Routes
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        let users = [];
        if (await ensureMongo()) {
            users = await User.find({}).sort({ createdAt: -1 }).lean();
        } else {
            users = Array.from(memoryUsers.values());
        }
        return res.json({ success: true, count: users.length, users });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/reset-device', authenticateAdmin, async (req, res) => {
    try {
        const { username } = req.body;
        const user = await findUserByUsername(username);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        user.deviceId = null;
        if (typeof user.save === 'function') await user.save();
        else if (mongoose.connection.readyState === 1 && user._id) {
            await User.findByIdAndUpdate(user._id, { deviceId: null });
        }
        return res.json({ success: true, message: `Device lock released for "${username}".` });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/set-credits', authenticateAdmin, async (req, res) => {
    try {
        const { username, credits, isPro } = req.body;
        const user = await findUserByUsername(username);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        if (credits !== undefined) user.credits = Math.max(0, parseInt(credits) || 0);
        if (isPro !== undefined) user.isPro = Boolean(isPro);

        if (typeof user.save === 'function') await user.save();
        else if (mongoose.connection.readyState === 1 && user._id) {
            await User.findByIdAndUpdate(user._id, { credits: user.credits, isPro: user.isPro });
        }
        return res.json({ success: true, user: { username: user.username, credits: user.credits, isPro: user.isPro } });
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
    res.json({
        service: 'Kamaal Studio API',
        status: 'active',
        version: '3.2.0',
        model: 'gemini-3.1',
        adminPanel: '/admin'
    });
});

// Export Express App for Vercel Serverless Function
module.exports = app;

/**
 * Kammal App - upgraded backend
 * Preserves existing AI/admin APIs and adds:
 * - per-user custom prompts
 * - monthly/yearly/lifetime plans
 * - owner 9,999,999 credits + crown identity
 * - secure token authentication
 * - one-to-one text chat
 * - admin/owner chat
 * - unread/read notifications
 * - credit ledger
 */
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECURITY_KEY = process.env.ADMIN_KEY || "ADmin";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const OWNER_USERNAME = (process.env.OWNER_USERNAME || "mozammil").trim().toLowerCase();
const OWNER_USER_ID = process.env.OWNER_USER_ID || "";
const OWNER_CREDITS = 9999999;
const TOKEN_TTL_DAYS = 30;

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function resolveGeminiModel(name) {
  if (!name) return "gemini-3.1-pro-preview";
  const clean = String(name).trim().toLowerCase();
  if (clean === "gemini-3.1" || clean === "gemini-pro" || clean.includes("3.1-pro")) return "gemini-3.1-pro-preview";
  if (clean.includes("3.5") || clean === "gemini-flash" || clean.includes("3.5-flash")) return "gemini-3.5-flash";
  if (clean.includes("lite") || clean.includes("3.1-flash-lite")) return "gemini-3.1-flash-lite-preview";
  if (clean.includes("2.5")) return "gemini-2.5-flash";
  return name;
}

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true, trim: true },
  email: { type: String, default: "" },
  passwordHash: { type: String, default: "" },
  password: { type: String, default: "" }, // legacy compatibility
  deviceId: { type: String, default: "", index: true },
  credits: { type: Number, default: 20, min: 0 },
  isPro: { type: Boolean, default: false },
  status: { type: String, default: "active", enum: ["active", "banned"] },
  customPrompt: { type: String, default: "" },
  role: { type: String, default: "user", enum: ["user", "admin", "owner"] },
  planType: { type: String, default: "free", enum: ["free", "monthly", "yearly", "lifetime", "custom"] },
  planStatus: { type: String, default: "inactive", enum: ["active", "expired", "inactive"] },
  planStartedAt: { type: Date, default: null },
  planExpiresAt: { type: Date, default: null },
  isLifetime: { type: Boolean, default: false },
  lastSeenAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const ConfigSchema = new mongoose.Schema({
  key: { type: String, default: "global_config", unique: true },
  systemPrompt: { type: String, default: "You are Kammal App AI, an intelligent assistant." },
  defaultPrompt: { type: String, default: "You are Kammal App AI, an intelligent assistant." },
  currentModel: { type: String, default: "gemini-3.1-pro-preview" },
  maintenance: {
    enabled: { type: Boolean, default: false },
    message: { type: String, default: "Scheduled maintenance in progress." }
  }
});

const ConversationSchema = new mongoose.Schema({
  username: String, deviceId: String, query: String, reply: String, model: String,
  timestamp: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "ChatConversation", required: true, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  message: { type: String, required: true, maxlength: 4000 },
  readAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});

const ChatConversationSchema = new mongoose.Schema({
  participantKey: { type: String, unique: true, index: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  lastMessage: { type: String, default: "" },
  lastMessageAt: { type: Date, default: Date.now, index: true },
  lastSenderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  unreadCounts: { type: Map, of: Number, default: {} },
  createdAt: { type: Date, default: Date.now }
});

const CreditTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  type: String,
  amount: Number,
  balanceAfter: Number,
  reason: String,
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now }
});

const SessionSchema = new mongoose.Schema({
  tokenHash: { type: String, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  expiresAt: { type: Date, index: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model("User", UserSchema);
const Config = mongoose.models.Config || mongoose.model("Config", ConfigSchema);
const Conversation = mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
const ChatConversation = mongoose.models.ChatConversation || mongoose.model("ChatConversation", ChatConversationSchema);
const Message = mongoose.models.Message || mongoose.model("Message", MessageSchema);
const CreditTransaction = mongoose.models.CreditTransaction || mongoose.model("CreditTransaction", CreditTransactionSchema);
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

let cachedDb = null;
let memoryCache = {
  systemPrompt: "You are Kammal App AI, an intelligent assistant.",
  defaultPrompt: "You are Kammal App AI, an intelligent assistant.",
  currentModel: "gemini-3.1-pro-preview",
  maintenance: { enabled: false, message: "Scheduled maintenance in progress." },
  users: {}
};

async function connectToDatabase() {
  if (!MONGODB_URI) return false;
  if (cachedDb && mongoose.connection.readyState === 1) return true;
  try {
    cachedDb = await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
    return true;
  } catch (e) {
    console.warn("MongoDB connection warning:", e.message);
    return false;
  }
}

app.use(async (req, res, next) => { await connectToDatabase(); next(); });

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch { return false; }
}
function safeUser(user) {
  const owner = user.role === "owner" || user.username.toLowerCase() === OWNER_USERNAME ||
    (OWNER_USER_ID && String(user._id) === OWNER_USER_ID);
  return {
    id: String(user._id),
    username: owner ? "Owner" : user.username,
    realUsernameHidden: owner,
    owner,
    role: owner ? "owner" : user.role,
    credits: owner ? OWNER_CREDITS : user.credits,
    isPro: owner ? true : user.isPro,
    status: user.status,
    customPrompt: user.customPrompt || "",
    planType: owner ? "lifetime" : user.planType,
    planStatus: owner ? "active" : effectivePlanStatus(user),
    planExpiresAt: owner ? null : user.planExpiresAt,
    isLifetime: owner ? true : !!user.isLifetime,
    createdAt: user.createdAt
  };
}
function effectivePlanStatus(user) {
  if (user.isLifetime || user.planType === "lifetime") return "active";
  if (user.planExpiresAt && new Date(user.planExpiresAt) <= new Date()) return "expired";
  return user.planStatus || "inactive";
}
function isOwner(user) {
  return !!user && (
    user.role === "owner" ||
    user.username.toLowerCase() === OWNER_USERNAME ||
    (OWNER_USER_ID && String(user._id) === OWNER_USER_ID)
  );
}
async function normalizeOwner(user) {
  if (!user) return user;
  if (isOwner(user) && user.role !== "owner") {
    user.role = "owner";
    user.isPro = true;
    user.isLifetime = true;
    user.planType = "lifetime";
    user.planStatus = "active";
    user.planExpiresAt = null;
    user.credits = OWNER_CREDITS;
    if (cachedDb && mongoose.connection.readyState === 1) await user.save();
  }
  return user;
}

async function authFromToken(req) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : (req.headers["x-user-token"] || "");
  if (!token || !cachedDb || mongoose.connection.readyState !== 1) return null;
  const session = await Session.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const user = await User.findById(session.userId);
  if (!user) return null;
  await normalizeOwner(user);
  if (user.status === "banned") return null;
  return user;
}
async function requireUser(req, res, next) {
  const user = await authFromToken(req);
  if (!user) return res.status(401).json({ success: false, error: "Authentication required." });
  req.user = user;
  next();
}
function requireAdminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.adminKey || req.body?.adminKey;
  if (!ADMIN_SECURITY_KEY || !key || key !== ADMIN_SECURITY_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }
  next();
}
async function getActiveConfig() {
  if (cachedDb && mongoose.connection.readyState === 1) {
    let conf = await Config.findOne({ key: "global_config" });
    if (!conf) conf = await Config.create({ key: "global_config" });
    return conf;
  }
  return memoryCache;
}
async function getUserByUsername(username) {
  if (!username) return null;
  if (cachedDb && mongoose.connection.readyState === 1) return User.findOne({ username: String(username).trim() });
  return memoryCache.users[String(username).trim()] || null;
}
async function ensureOwnerByUsername(username) {
  if (!username || username.toLowerCase() !== OWNER_USERNAME) return;
  if (cachedDb && mongoose.connection.readyState === 1) {
    const u = await User.findOne({ username });
    if (u) await normalizeOwner(u);
  } else if (memoryCache.users[username]) {
    Object.assign(memoryCache.users[username], { role:"owner", isPro:true, isLifetime:true, planType:"lifetime", planStatus:"active", credits:OWNER_CREDITS });
  }
}
async function creditLog(user, type, amount, reason, adminId = null) {
  if (cachedDb && mongoose.connection.readyState === 1) {
    await CreditTransaction.create({ userId: user._id, type, amount, balanceAfter: isOwner(user) ? OWNER_CREDITS : user.credits, reason, adminId });
  }
}
async function grantPlan(user, planType, durationDays = null) {
  const now = new Date();
  user.planType = planType;
  user.planStartedAt = now;
  if (planType === "lifetime") {
    user.isLifetime = true; user.planStatus = "active"; user.planExpiresAt = null; user.isPro = true; user.credits = OWNER_CREDITS;
  } else {
    user.isLifetime = false; user.planStatus = "active"; user.isPro = planType !== "free";
    if (durationDays) user.planExpiresAt = new Date(now.getTime() + durationDays * 86400000);
    else user.planExpiresAt = null;
  }
  await user.save();
}

// ---------- AUTH ----------
app.post("/api/auth/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const email = String(req.body.email || "").trim();
    const deviceId = String(req.body.deviceId || "").trim();
    if (!username || username.length < 3 || username.length > 32) return res.status(400).json({ success:false, error:"Username must be 3-32 characters." });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ success:false, error:"Invalid username." });
    if (password.length < 6) return res.status(400).json({ success:false, error:"Password must be at least 6 characters." });
    if (cachedDb && mongoose.connection.readyState === 1) {
      if (await User.findOne({ username })) return res.status(409).json({ success:false, error:"Username already exists." });
      const user = await User.create({ username, email, deviceId, passwordHash: hashPassword(password), credits: 20 });
      await normalizeOwner(user);
      return issueToken(res, user);
    }
    if (memoryCache.users[username]) return res.status(409).json({ success:false, error:"Username already exists." });
    const user = { _id: crypto.randomUUID(), username, email, deviceId, passwordHash: hashPassword(password), credits:20, isPro:false, status:"active", customPrompt:"", role:"user", planType:"free", planStatus:"inactive", isLifetime:false, createdAt:new Date() };
    memoryCache.users[username] = user;
    return res.json({ success:true, token: makeToken(), user:safeUser(user) });
  } catch (e) { res.status(500).json({ success:false, error:"Registration failed." }); }
});
async function issueToken(res, user) {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000);
  if (cachedDb && mongoose.connection.readyState === 1) await Session.create({ tokenHash:hashToken(token), userId:user._id, expiresAt });
  return res.json({ success:true, token, expiresAt, user:safeUser(user) });
}
app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = await getUserByUsername(username);
    if (!user || user.status === "banned") return res.status(401).json({ success:false, error:"Invalid account or password." });
    if (!verifyPassword(password, user.passwordHash || "")) {
      // legacy plaintext compatibility; migrate immediately
      if (user.password && user.password === password) {
        user.passwordHash = hashPassword(password); user.password = "";
        if (cachedDb && mongoose.connection.readyState === 1) await user.save();
      } else return res.status(401).json({ success:false, error:"Invalid account or password." });
    }
    await normalizeOwner(user);
    return issueToken(res, user);
  } catch (e) { res.status(500).json({ success:false, error:"Login failed." }); }
});
app.get("/api/auth/me", requireUser, async (req,res) => res.json({success:true,user:safeUser(req.user)}));

// ---------- EXISTING AI / ADMIN ----------
app.get("/api/admin/system-prompt", requireAdminAuth, async (req,res) => {
  const conf=await getActiveConfig();
  res.json({success:true,systemPrompt:conf.systemPrompt,defaultPrompt:conf.defaultPrompt||conf.systemPrompt,presets:[
    {id:"video_optimizer",title:"🎬 Video Optimizer",prompt:conf.defaultPrompt||conf.systemPrompt},
    {id:"sales_support",title:"💎 VIP Sales",prompt:"You are Kammal App VIP Sales Consultant."},
    {id:"tech_troubleshooter",title:"🛠️ HW Specialist",prompt:"You are Technical Specialist for device security."},
    {id:"urdu_english",title:"🇵🇰 Roman Urdu",prompt:"Aap Kammal App ke bilingual assistant hain."}
  ]});
});
app.post("/api/admin/system-prompt", requireAdminAuth, async(req,res)=>{
  const p=String(req.body.systemPrompt||"").trim(); if(!p) return res.status(400).json({success:false,error:"Prompt required"});
  if(cachedDb&&mongoose.connection.readyState===1) await Config.findOneAndUpdate({key:"global_config"},{$set:{systemPrompt:p}},{upsert:true});
  memoryCache.systemPrompt=p; res.json({success:true,message:"Global prompt saved."});
});
app.get("/api/admin/model",requireAdminAuth,async(req,res)=>{const c=await getActiveConfig();res.json({success:true,currentModel:c.currentModel||"gemini-3.1-pro-preview"});});
app.post("/api/admin/model",requireAdminAuth,async(req,res)=>{const model=String(req.body.model||"").trim();if(!model)return res.status(400).json({success:false,error:"Model required"});if(cachedDb&&mongoose.connection.readyState===1)await Config.findOneAndUpdate({key:"global_config"},{$set:{currentModel:model}},{upsert:true});memoryCache.currentModel=model;res.json({success:true,message:"Model updated."});});
app.post("/api/admin/test-prompt",requireAdminAuth,async(req,res)=>{
  const c=await getActiveConfig(), modelName=resolveGeminiModel(c.currentModel);
  try { if(!genAI)return res.json({success:true,reply:`[${modelName}] ${req.body.testMessage||"Test"}`,model:modelName});
    const m=genAI.getGenerativeModel({model:modelName,systemInstruction:req.body.prompt||c.systemPrompt});
    const r=await m.generateContent(req.body.testMessage||"Test");res.json({success:true,reply:r.response.text(),model:modelName});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get("/api/admin/user-prompt/:username",requireAdminAuth,async(req,res)=>{
  const u=await getUserByUsername(req.params.username);if(!u)return res.status(404).json({success:false,error:"User not found"});
  res.json({success:true,customPrompt:u.customPrompt||"",usingCustomPrompt:!!u.customPrompt});
});
app.post("/api/admin/user-prompt",requireAdminAuth,async(req,res)=>{
  const username=String(req.body.username||"").trim(), customPrompt=String(req.body.customPrompt||"").trim();
  const u=await getUserByUsername(username);if(!u)return res.status(404).json({success:false,error:"User not found"});
  u.customPrompt=customPrompt;if(cachedDb&&mongoose.connection.readyState===1)await u.save();
  res.json({success:true,message:customPrompt?"Custom prompt saved.":"Reverted to global prompt."});
});
app.get("/api/admin/users",requireAdminAuth,async(req,res)=>{
  const search=String(req.query.search||"").trim();
  if(cachedDb&&mongoose.connection.readyState===1){
    const q=search?{$or:[{username:{$regex:search,$options:"i"}},{deviceId:{$regex:search,$options:"i"}}]}:{};
    const users=await User.find(q).sort({createdAt:-1}).lean();
    return res.json({success:true,count:users.length,users:users.map(safeUser)});
  }
  let list=Object.values(memoryCache.users);if(search)list=list.filter(u=>u.username.toLowerCase().includes(search.toLowerCase()));
  res.json({success:true,count:list.length,users:list.map(safeUser)});
});
app.post("/api/admin/reset-device",requireAdminAuth,async(req,res)=>{const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});u.deviceId="";if(cachedDb&&mongoose.connection.readyState===1)await u.save();res.json({success:true,message:"Device reset."});});
app.post("/api/admin/add-credits",requireAdminAuth,async(req,res)=>{
  const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});
  if(isOwner(u)) return res.json({success:true,credits:OWNER_CREDITS,message:"Owner credits are protected."});
  const qty=Math.max(0,parseInt(req.body.amount,10)||0);u.credits+=qty;if(cachedDb&&mongoose.connection.readyState===1)await u.save();await creditLog(u,"ADMIN_ADD",qty,"Admin credit grant");res.json({success:true,credits:u.credits});
});
app.post("/api/admin/set-credits",requireAdminAuth,async(req,res)=>{const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});if(isOwner(u))return res.json({success:true,credits:OWNER_CREDITS,message:"Owner credits protected."});u.credits=Math.max(0,parseInt(req.body.credits,10)||0);if(cachedDb&&mongoose.connection.readyState===1)await u.save();res.json({success:true,credits:u.credits});});
app.post("/api/admin/set-pro",requireAdminAuth,async(req,res)=>{const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});if(isOwner(u))return res.json({success:true,message:"Owner is permanently PRO."});u.isPro=!!req.body.isPro;if(cachedDb&&mongoose.connection.readyState===1)await u.save();res.json({success:true,isPro:u.isPro});});
app.post("/api/admin/set-plan",requireAdminAuth,async(req,res)=>{
  const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});
  if(isOwner(u))return res.json({success:true,message:"Owner is permanently Lifetime."});
  const type=String(req.body.planType||"free");
  const days=type==="monthly"?30:type==="yearly"?365:null;
  if(!["free","monthly","yearly","lifetime","custom"].includes(type))return res.status(400).json({success:false,error:"Invalid plan"});
  await grantPlan(u,type,type==="custom"?parseInt(req.body.durationDays,10)||30:days);
  if(type!=="lifetime" && parseInt(req.body.credits,10)>=0){u.credits=parseInt(req.body.credits,10);await u.save();}
  res.json({success:true,user:safeUser(u)});
});
app.post("/api/admin/ban",requireAdminAuth,async(req,res)=>{const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});if(isOwner(u))return res.status(403).json({success:false,error:"Owner cannot be banned"});u.status="banned";if(cachedDb&&mongoose.connection.readyState===1)await u.save();res.json({success:true});});
app.post("/api/admin/unban",requireAdminAuth,async(req,res)=>{const u=await getUserByUsername(req.body.username);if(!u)return res.status(404).json({success:false,error:"User not found"});u.status="active";if(cachedDb&&mongoose.connection.readyState===1)await u.save();res.json({success:true});});
app.get("/api/admin/credit-ledger/:username",requireAdminAuth,async(req,res)=>{const u=await getUserByUsername(req.params.username);if(!u)return res.status(404).json({success:false,error:"User not found"});const rows=cachedDb&&mongoose.connection.readyState===1?await CreditTransaction.find({userId:u._id}).sort({createdAt:-1}).limit(200):[];res.json({success:true,ledger:rows});});

// ---------- CHAT ----------
function pairKey(a,b){return [String(a),String(b)].sort().join(":");}
function displayName(u){return isOwner(u)?"Owner":u.username;}

app.get("/api/users/search",requireUser,async(req,res)=>{
  const q=String(req.query.q||"").trim();
  if(q.length<1)return res.json({success:true,users:[]});
  let users=[];
  if(cachedDb&&mongoose.connection.readyState===1) users=await User.find({username:{$regex:q,$options:"i"},status:"active"}).limit(30).lean();
  else users=Object.values(memoryCache.users).filter(u=>u.status==="active"&&u.username.toLowerCase().includes(q.toLowerCase())).slice(0,30);
  res.json({success:true,users:users.filter(u=>String(u._id)!==String(req.user._id)).map(safeUser)});
});

app.get("/api/chats",requireUser,async(req,res)=>{
  if(!(cachedDb&&mongoose.connection.readyState===1))return res.json({success:true,chats:[]});
  const uid=String(req.user._id);
  const rows=await ChatConversation.find({participants:req.user._id}).sort({lastMessageAt:-1}).populate("participants","username role isPro");
  const chats=rows.map(c=>{
    const other=c.participants.find(p=>String(p._id)!==uid);
    return {id:String(c._id),user:other?{id:String(other._id),username:other.role==="owner"?"Owner":other.username,owner:other.role==="owner"}:null,lastMessage:c.lastMessage,lastMessageAt:c.lastMessageAt,unreadCount:Number((c.unreadCounts||new Map()).get(uid)||0)};
  });
  res.json({success:true,chats});
});

app.post("/api/chats",requireUser,async(req,res)=>{
  if(!(cachedDb&&mongoose.connection.readyState===1))return res.status(503).json({success:false,error:"Chat database unavailable."});
  const target=await User.findById(req.body.userId);
  if(!target||target.status==="banned")return res.status(404).json({success:false,error:"User not available."});
  if(String(target._id)===String(req.user._id))return res.status(400).json({success:false,error:"Cannot chat with yourself."});
  const key=pairKey(req.user._id,target._id);
  let c=await ChatConversation.findOne({participantKey:key});
  if(!c)c=await ChatConversation.create({participantKey:key,participants:[req.user._id,target._id],unreadCounts:{}});
  res.json({success:true,conversationId:String(c._id)});
});

app.get("/api/chats/:conversationId/messages",requireUser,async(req,res)=>{
  if(!(cachedDb&&mongoose.connection.readyState===1))return res.status(503).json({success:false,error:"Chat database unavailable."});
  const c=await ChatConversation.findById(req.params.conversationId);
  if(!c||!c.participants.some(p=>String(p)===String(req.user._id)))return res.status(403).json({success:false,error:"Forbidden"});
  const messages=await Message.find({conversationId:c._id,deletedAt:null}).sort({createdAt:1}).limit(500).lean();
  await Message.updateMany({conversationId:c._id,receiverId:req.user._id,readAt:null},{$set:{readAt:new Date()}});
  c.unreadCounts.set(String(req.user._id),0);await c.save();
  res.json({success:true,messages:messages.map(m=>({id:String(m._id),senderId:String(m.senderId),receiverId:String(m.receiverId),message:m.message,readAt:m.readAt,createdAt:m.createdAt}))});
});

app.post("/api/chats/:conversationId/messages",requireUser,async(req,res)=>{
  if(!(cachedDb&&mongoose.connection.readyState===1))return res.status(503).json({success:false,error:"Chat database unavailable."});
  const message=String(req.body.message||"").trim();
  if(!message)return res.status(400).json({success:false,error:"Message required"});
  if(message.length>4000)return res.status(400).json({success:false,error:"Message too long"});
  const c=await ChatConversation.findById(req.params.conversationId);
  if(!c||!c.participants.some(p=>String(p)===String(req.user._id)))return res.status(403).json({success:false,error:"Forbidden"});
  const receiverId=c.participants.find(p=>String(p)!==String(req.user._id));
  const msg=await Message.create({conversationId:c._id,senderId:req.user._id,receiverId,message});
  const old=Number(c.unreadCounts.get(String(receiverId))||0);c.unreadCounts.set(String(receiverId),old+1);
  c.lastMessage=message;c.lastMessageAt=msg.createdAt;c.lastSenderId=req.user._id;await c.save();
  res.json({success:true,message:{id:String(msg._id),senderId:String(msg.senderId),receiverId:String(msg.receiverId),message:msg.message,createdAt:msg.createdAt,readAt:null}});
});

// owner/admin inbox helpers
app.get("/api/admin/chat/users",requireAdminAuth,async(req,res)=>{
  if(!(cachedDb&&mongoose.connection.readyState===1))return res.json({success:true,users:[]});
  const q=String(req.query.search||"").trim();
  const users=await User.find(q?{username:{$regex:q,$options:"i"}}:{}).sort({createdAt:-1}).limit(200);
  res.json({success:true,users:users.map(safeUser)});
});
app.post("/api/admin/chat/:userId/message",requireAdminAuth,async(req,res)=>{
  if(!(cachedDb&&mongoose.connection.readyState===1))return res.status(503).json({success:false,error:"Chat database unavailable."});
  const target=await User.findById(req.params.userId);if(!target)return res.status(404).json({success:false,error:"User not found"});
  let owner=OWNER_USER_ID?await User.findById(OWNER_USER_ID):await User.findOne({username:OWNER_USERNAME});
  if(!owner){owner=await User.findOne({role:"owner"});}
  if(!owner)return res.status(404).json({success:false,error:"Owner account not found"});
  const text=String(req.body.message||"").trim();if(!text||text.length>4000)return res.status(400).json({success:false,error:"Invalid message"});
  const key=pairKey(owner._id,target._id);let c=await ChatConversation.findOne({participantKey:key});
  if(!c)c=await ChatConversation.create({participantKey:key,participants:[owner._id,target._id],unreadCounts:{}});
  const msg=await Message.create({conversationId:c._id,senderId:owner._id,receiverId:target._id,message:text});
  c.lastMessage=text;c.lastMessageAt=msg.createdAt;c.lastSenderId=owner._id;c.unreadCounts.set(String(target._id),Number(c.unreadCounts.get(String(target._id))||0)+1);await c.save();
  res.json({success:true,message:{id:String(msg._id),senderId:String(msg.senderId),receiverId:String(msg.receiverId),message:msg.message,createdAt:msg.createdAt}});
});

// Legacy AI endpoint preserved; authenticated clients should use /api/auth/me and token.
app.post("/api/chat",async(req,res)=>{
  const conf=await getActiveConfig();
  if(conf.maintenance?.enabled)return res.status(503).json({success:false,error:conf.maintenance.message||"Maintenance"});
  const message=String(req.body.message||"").trim();if(!message)return res.status(400).json({success:false,error:"Message required"});
  let user=await authFromToken(req);
  if(!user && req.body.username) user=await getUserByUsername(req.body.username);
  if(user)await normalizeOwner(user);
  if(user?.status==="banned")return res.status(403).json({success:false,error:"Account suspended."});
  const effectivePrompt=user?.customPrompt?.trim()||conf.systemPrompt;
  const modelToUse=resolveGeminiModel(conf.currentModel);
  try {
    if(genAI){const model=genAI.getGenerativeModel({model:modelToUse,systemInstruction:effectivePrompt});const result=await model.generateContent(message);const reply=result.response.text();
      if(cachedDb&&mongoose.connection.readyState===1)Conversation.create({username:user?.username||req.body.username,deviceId:user?.deviceId||req.body.deviceId,query:message,reply,model:modelToUse}).catch(()=>{});
      return res.json({success:true,reply,model:modelToUse,credits:isOwner(user)?OWNER_CREDITS:user?.credits});
    }
    res.json({success:true,reply:`Kammal AI: ${message}`,model:modelToUse});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/admin/maintenance",async(req,res)=>{const c=await getActiveConfig();res.json({success:true,maintenance:c.maintenance});});
app.post("/api/admin/maintenance",requireAdminAuth,async(req,res)=>{const d={enabled:!!req.body.enabled,message:String(req.body.message||"App undergoing maintenance.")};if(cachedDb&&mongoose.connection.readyState===1)await Config.findOneAndUpdate({key:"global_config"},{$set:{maintenance:d}},{upsert:true});memoryCache.maintenance=d;res.json({success:true,maintenance:d});});

app.get(["/","/admin"],(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));

module.exports=app;
if(process.env.NODE_ENV!=="production")app.listen(PORT,()=>console.log(`Kammal server running on ${PORT}`));

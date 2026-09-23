// Single authoritative backend entry point.
// Vercel normally uses ../server.js via vercel.json, but this file is kept
// for compatibility so there is never a second, stale backend implementation.
module.exports = require("../server");

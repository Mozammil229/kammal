/**
 * Local server launcher for Kamaal Studio
 * Runs the exact same consolidated API backend locally on specified PORT
 */
const app = require('./api/index');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🌊 Local Kamaal Studio server running at http://localhost:${PORT}`);
    console.log(`📊 Admin Panel accessible at http://localhost:${PORT}/admin`);
    console.log(`ℹ️ Help Guide accessible at http://localhost:${PORT}/help`);
});
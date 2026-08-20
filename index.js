const fs = require('fs');
const path = require('path');
const BotManager = require('./src/bot/mcBot');
const startWebServer = require('./src/web/server');

// Load config
const configPath = path.join(__dirname, 'config.json');
let config = {};

try {
  const rawConfig = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(rawConfig);
} catch (err) {
  console.error('[Config Error] Gagal membaca config.json:', err.message);
  process.exit(1);
}

// Instantiate Bot Manager
const botManager = new BotManager(config);

// Start Web Dashboard Server
startWebServer(botManager, config);

console.log(`[INFO] Bot dalam status Standby (OFFLINE). Silakan buka Web Dashboard untuk menghubungkan bot.`);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[INFO] Mematikan bot dan web server...');
  botManager.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[INFO] Mematikan bot...');
  botManager.stop();
  process.exit(0);
});

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

function startWebServer(botManager, config) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  const port = config.web.port || 3000;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Socket.io Connection
  io.on('connection', (socket) => {
    console.log('[Web Dashboard] Client terhubung.');

    // Kirim state awal & chat logs
    socket.emit('state', botManager.getBotState());
    socket.emit('chatLogs', botManager.chatLogs);

    // Command from Web UI
    socket.on('startBot', () => {
      botManager.start();
    });

    socket.on('stopBot', () => {
      botManager.stop();
    });

    socket.on('sendChat', (message) => {
      if (message && typeof message === 'string') {
        botManager.sendChat(message);
      }
    });

    socket.on('toggleAntiAfk', (enabled) => {
      botManager.antiAfk.setEnabled(enabled);
      botManager.emitState();
    });

    socket.on('toggleAutoEat', (enabled) => {
      botManager.autoEat.setEnabled(enabled);
      botManager.emitState();
    });

    socket.on('toggleAutoAttack', (enabled) => {
      if (enabled) {
        botManager.farmHelper.startAutoAttack();
      } else {
        botManager.farmHelper.stopAutoAttack();
      }
      botManager.emitState();
    });

    socket.on('dropTrash', () => {
      botManager.farmHelper.dropTrashItems();
    });

    socket.on('dropAll', () => {
      botManager.farmHelper.dropAllItems();
    });

    socket.on('updateConfig', (newConfig) => {
      botManager.updateConfig(newConfig);
      socket.emit('configUpdated', botManager.config);
    });
  });

  // Relay events from BotManager to Socket.io
  botManager.on('state', (statePayload) => {
    io.emit('state', statePayload);
  });

  botManager.on('chat', (chatPayload) => {
    io.emit('chat', chatPayload);
  });

  botManager.on('status', (statusStr) => {
    io.emit('status', statusStr);
  });

  server.listen(port, () => {
    console.log(`\n======================================================`);
    console.log(`  🚀 Web Dashboard Bot Minecraft Siap!`);
    console.log(`  🌐 Buka Browser di: http://localhost:${port}`);
    console.log(`======================================================\n`);
  });

  return { app, server, io };
}

module.exports = startWebServer;

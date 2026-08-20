const mineflayer = require('mineflayer');
const EventEmitter = require('events');
const { pathfinder, goals, Movements } = require('mineflayer-pathfinder');
const AntiAfkManager = require('./antiAfk');
const AutoEatManager = require('./autoEat');
const FarmHelper = require('./farm');
const ChatCommandHandler = require('./chatCmd');

class BotManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config || {};
    this.bot = null;
    this.status = 'OFFLINE'; // OFFLINE, CONNECTING, ONLINE, DISCONNECTED
    this.reconnectTimer = null;
    this.manualStop = false;
    this.chatLogs = [];
    this.maxLogs = 100;
    this.lastLoginAttempt = 0;
    this.isAuthenticated = false; // Flag: sudah berhasil login ke plugin auth server
    this.walkTestExecuted = false; // Flag: uji jalan 50 block sudah dijalankan di sesi ini
    this.nextReconnectDelay = null; // Custom delay untuk reconnect berikutnya
    this.heartbeatTimer = null; // Pulse timer untuk menjaga socket Netty Purpur aktif
    
    // Debugging Variables
    this.moveState = 'IDLE'; // IDLE, MOVING, FOLLOWING
    this.hasSaidHello = false; // Flag chat sekali per koneksi

    // Global Exception Handlers (jika belum didaftarkan)
    if (!process.listeners('uncaughtException').some(l => l.name === 'botManagerUncaught')) {
      const botManagerUncaught = (err) => {
        this.logSystem(`[UNCAUGHT EXCEPTION] 🚨 ${err.message}\n${err.stack}`);
      };
      process.on('uncaughtException', botManagerUncaught);
    }
    if (!process.listeners('unhandledRejection').some(l => l.name === 'botManagerUnhandled')) {
      const botManagerUnhandled = (reason, promise) => {
        const msg = reason && reason.stack ? reason.stack : reason;
        this.logSystem(`[UNHANDLED REJECTION] 🚨 Promise rejection: ${msg}`);
      };
      process.on('unhandledRejection', botManagerUnhandled);
    }

    // Submodules
    this.antiAfk = new AntiAfkManager(this.config.antiAfk);
    this.autoEat = new AutoEatManager(this.config.autoEat);
    this.farmHelper = new FarmHelper(this.config.farm);
    this.chatCmd = new ChatCommandHandler(this);
  }

  start() {
    this.manualStop = false;
    this.connect();
  }

  stop() {
    this.manualStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.antiAfk) this.antiAfk.stop();
    if (this.farmHelper) this.farmHelper.stopAutoAttack();

    if (this.bot) {
      try {
        if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
        this.bot.quit();
      } catch (err) {
        // Ignore quit errors
      }
      this.bot = null;
    }
    this.updateStatus('OFFLINE');
    this.logSystem('Bot dihentikan oleh pengguna.');
  }

  connect() {
    if (this.status === 'CONNECTING' || this.status === 'ONLINE') return;
    this.updateStatus('CONNECTING');
    this.isAuthenticated = false; // Reset flag autentikasi untuk koneksi baru
    this.hasSaidHello = false;
    this.moveState = 'IDLE';
    this.walkTestExecuted = false;
    this.logSystem(`[DEBUG KONEKSI] Menghubungkan ke ${this.config.server.host}:${this.config.server.port} sebagai ${this.config.server.username}...`);

    const targetVersion = (this.config.server.version && this.config.server.version !== 'auto' && this.config.server.version !== false)
      ? this.config.server.version
      : '1.21.11';

    const botOptions = {
      host: this.config.server.host,
      port: parseInt(this.config.server.port) || 25565,
      username: this.config.server.username,
      auth: this.config.server.auth || 'offline',
      version: targetVersion,
      checkTimeoutInterval: 5 * 60 * 1000, // 5 menit agar Mineflayer tidak memutus koneksi sendiri
      hideErrors: true
    };

    try {
      this.bot = mineflayer.createBot(botOptions);
      this.bot.loadPlugin(pathfinder);
      this.setupEvents();
    } catch (err) {
      this.logSystem(`Gagal membuat instance bot: ${err.message}`);
      this.updateStatus('OFFLINE');
      this.scheduleReconnect();
    }
  }

  setupEvents() {
    if (!this.bot) return;

    // Init submodules
    this.autoEat.init(this.bot);
    this.antiAfk.init(this.bot, this);
    this.farmHelper.init(this.bot);
    this.chatCmd.init(this.bot);

    // ─── EVENT DEBUG LOGGING KONEKSI & KOMUNIKASI ───
    this.bot.once('login', () => {
      this.logSystem(`[DEBUG LOG 🔑] Handshake & protokol session berhasil terhubung ke server!`);
    });

    this.bot.once('spawn', () => {
      if (!this.bot) return;
      // KRITIS: Hapus reset isAuthenticated di spawn.
      // Jika reset dilakukan di sini, saat bot berpindah dimensi (yang memicu event spawn lagi)
      // atau jika event messagestr tiba sesaat sebelum spawn, status auth akan hilang
      // dan bot akan mengirim /login secara berulang.
      this.hasSaidHello = false;
      this.moveState = 'IDLE';
      this.updateStatus('ONLINE');

      const pos = this.bot.entity ? this.bot.entity.position : { x: 0, y: 0, z: 0 };
      const gm = this.bot.game ? this.bot.game.gameMode : 'unknown';
      this.logSystem(`[DEBUG LOG 🌍] Bot ${this.bot.username} SPAWN di pos (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) | GameMode: ${gm}`);
      this.emitState();

      // Start Heartbeat Pulse (mengirim mikro-paket setiap 4 detik agar Purpur Netty tidak melempar ECONNRESET)
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.bot && this.bot.entity && this.status === 'ONLINE' && this.moveState === 'IDLE') {
          try {
            const yaw = (this.bot.entity.yaw || 0) + 0.0001;
            this.bot.look(yaw, this.bot.entity.pitch || 0, true); // force=true agar packet PASTI dikirim
          } catch (e) {}
        }
      }, 4000);

      // Auto-Login: Kirim /login agresif dan cepat agar AuthMe tidak timeout
      const al = this.config.autoLogin;
      if (al && al.enabled && al.password) {
        const pwd = al.password;
        // Queue login attempts: 500ms, 3s, 6s, 10s, 15s, 25s, 40s
        const loginAttempts = [500, 3000, 6000, 10000, 15000, 25000, 40000];
        loginAttempts.forEach((delay, i) => {
          setTimeout(() => {
            // Jika bot sudah berhasil login/autentikasi, BERHENTI spam /login
            if (!this.bot || this.moveState === 'DISCONNECTED' || this.isAuthenticated) return;
            
            // Jika ini percobaan ke-3 (6 detik), coba /register just in case
            if (i === 2) {
              this.logSystem(`[AutoLogin] Mencoba /register (percobaan ${i+1})...`);
              this.bot.chat(`/register ${pwd} ${pwd}`);
            } else {
              this.logSystem(`[AutoLogin] Mengirim /login (percobaan ${i+1})...`);
              this.bot.chat(`/login ${pwd}`);
            }
          }, delay);
        });
      } else {
        this.logSystem(`[INFO LOGIN] Jika server memerlukan autentikasi, silakan ketik /login <password> pada Live Chat Console.`);
      }
    });

    // Capture Title & Actionbar dari Server
    this.bot.on('title', (text) => {
      if (text) this.logSystem(`[SERVER TITLE 📢] ${text}`);
    });

    this.bot.on('actionBar', (text) => {
      if (text) {
        const str = typeof text === 'string' ? text : (text.text || JSON.stringify(text));
        if (str && str.trim()) this.logSystem(`[SERVER ACTIONBAR 💬] ${str}`);
      }
    });

    this.bot.on('respawn', () => {
      this.logSystem(`[DEBUG LOG 🔄] Bot respawn / berpindah dimensi world.`);
    });

    this.bot.on('forcedMove', () => {
      if (this.bot && this.bot.entity) {
        const p = this.bot.entity.position;
        this.logSystem(`[DEBUG LOG 📍] Server memindahkan pos bot paksa ke (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}).`);
      }
    });

    // ─── RAW PACKET LISTENER: Deteksi AuthMeUI GUI & Debug ───
    // windowOpen event TIDAK berjalan di Mineflayer 1.21+ (bug protokol)
    // Gunakan raw packet listener sebagai gantinya
    if (this.bot._client) {
      this.bot._client.on('open_screen', (packet) => {
        if (!this.bot) return;
        const title = packet.windowTitle ? JSON.stringify(packet.windowTitle) : 'unknown';
        const windowId = packet.windowId;
        const windowType = packet.inventoryType || packet.windowType || 'unknown';
        this.logSystem(`[PACKET GUI 🪟] Server membuka window: id=${windowId}, type=${windowType}, title=${title}`);

        // Jika AuthMeUI GUI terdeteksi, coba login dan tutup window
        const al = this.config.autoLogin;
        if (al && al.enabled && al.password && !this.isAuthenticated) {
          this.logSystem(`[AuthMeUI 🔑] GUI terdeteksi via raw packet! Mengirim /login dan menutup window...`);

          // Kirim /login
          setTimeout(() => {
            if (!this.bot || this.isAuthenticated) return;
            this.bot.chat(`/login ${al.password}`);
          }, 300);

          // Tutup window GUI agar AuthMe membuka akses chat/command
          setTimeout(() => {
            if (!this.bot) return;
            try {
              this.bot._client.write('close_window', { windowId: windowId });
              this.logSystem(`[AuthMeUI 🪟] Window id=${windowId} ditutup via raw packet.`);
            } catch (e) {}
            // Kirim ulang /login setelah tutup window
            setTimeout(() => {
              if (!this.bot || this.isAuthenticated) return;
              this.bot.chat(`/login ${al.password}`);
              this.logSystem(`[AuthMeUI 🔑] Mengirim ulang /login setelah tutup GUI...`);
            }, 500);
          }, 800);
        }
      });

      // Debug: Log paket custom_payload / plugin_message dari server
      this.bot._client.on('custom_payload', (packet) => {
        if (!this.bot) return;
        const channel = packet.channel || 'unknown';
        if (channel.includes('auth') || channel.includes('login') || channel.includes('nlogin')) {
          this.logSystem(`[PACKET PLUGIN 📦] Plugin channel: ${channel}`);
        }
      });

      // Debug: Log paket keep_alive untuk memantau apakah server meminta keep_alive dan bot membalasnya
      this.bot._client.on('keep_alive', (packet) => {
        // this.logSystem(`[DEBUG KEEPALIVE] Server mengirim keep_alive id=${packet.keepAliveId}`);
      });
      this.bot._client.on('packet', (data, meta) => {
        if (meta.name === 'keep_alive' && meta.state === 'play') {
           // Uncomment if you want extremely verbose keep_alive logging
           // this.logSystem(`[DEBUG KEEPALIVE] Server -> Bot (ID: ${data.keepAliveId})`);
        }
      });

      // DEBUG: Monitor paket pergerakan KELUAR untuk melihat apakah ada NaN atau nilai aneh sebelum ECONNRESET
      const oldWrite = this.bot._client.write.bind(this.bot._client);
      this.bot._client.write = (name, params) => {
        if (name === 'position' || name === 'look' || name === 'position_look') {
          // Cek apakah ada nilai NaN
          let hasNaN = false;
          for (let key in params) {
            if (typeof params[key] === 'number' && isNaN(params[key])) {
              hasNaN = true;
            }
          }
          if (hasNaN) {
            this.logSystem(`[CRITICAL WARNING] Mencegah pengiriman paket ${name} yang mengandung NaN! params: ${JSON.stringify(params)}`);
            return; // BLOKIR pengiriman paket rusak agar koneksi tidak terputus (ECONNRESET)
          }
          // Uncomment untuk verbose trace pergerakan
          // this.logSystem(`[DEBUG OUTBOUND] ${name}: ${JSON.stringify(params)}`);
        }
        oldWrite(name, params);
      };

    }

    // Fallback: Tetap dengarkan windowOpen jika event ini terpancar
    this.bot.on('windowOpen', (window) => {
      if (!this.bot) return;
      const titleRaw = window.title ? window.title.toString() : '';
      this.logSystem(`[SERVER GUI 🪟] windowOpen event: "${titleRaw}"`);

      const al = this.config.autoLogin;
      if (al && al.enabled && al.password && !this.isAuthenticated) {
        setTimeout(() => {
          if (!this.bot || this.isAuthenticated) return;
          this.bot.chat(`/login ${al.password}`);
          // Tutup window
          if (this.bot.currentWindow) {
            try { this.bot.closeWindow(this.bot.currentWindow); } catch (e) {}
          }
        }, 500);
      }
    });

    // --- AUTO RESPAWN EVENT ---
    this.bot.on('death', () => {
      this.logSystem(`[DEATH 💀] Bot mati! Menunggu respawn...`);
      // Mineflayer secara default akan otomatis mengirim respawn packet, 
      // tetapi untuk memastikan di server-server custom, kita panggil secara eksplisit jika bisa:
      // Kita beri delay sejenak agar chunk ter-load.
      setTimeout(() => {
        if (this.bot && this.bot.isAlive === false) {
           this.logSystem(`[RESPAWN] Mengirim permintaan respawn ke server...`);
           this.bot.chat('/respawn'); // Kadang server butuh command ini
        }
      }, 3000);
    });

    this.bot.on('health', () => {
      this.emitState();
    });

    this.bot.on('chat', (username, message) => {
      const chatItem = {
        type: 'chat',
        sender: username,
        text: message,
        time: new Date().toLocaleTimeString()
      };
      this.addLog(chatItem);
      this.emit('chat', chatItem);
    });

    this.bot.on('whisper', (username, message) => {
      const chatItem = {
        type: 'whisper',
        sender: username,
        text: message,
        time: new Date().toLocaleTimeString()
      };
      this.addLog(chatItem);
      this.emit('chat', chatItem);
    });

    this.bot.on('messagestr', (message) => {
      if (message && message.trim()) {
        const sysMsg = {
          type: 'system',
          sender: 'SERVER',
          text: message,
          time: new Date().toLocaleTimeString()
        };
        this.addLog(sysMsg);
        this.emit('chat', sysMsg);

        // Detect login / register prompt and notify user on console
        this.detectAndPerformLogin(message);

        // Detect chat command from raw Spigot/Essentials whisper messages
        if (this.chatCmd) {
          this.chatCmd.handleRawMessage(message);
        }
      }
    });

    this.bot.on('kicked', (reason) => {
      const cleanReason = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.logSystem(`[KICKED] 👢 Bot di-kick dari server. Alasan: ${cleanReason}`);
      this.updateStatus('DISCONNECTED');

      // Jika di-kick karena username duplikat, atur jeda reconnect ke 20 detik
      if (cleanReason.includes('same username') || cleanReason.includes('already playing')) {
        this.nextReconnectDelay = 20000;
        this.logSystem(`Menunggu 20 detik agar sesi sebelumnya dibersihkan server...`);
      }
    });

    this.bot.on('error', (err) => {
      const msg = err ? (err.message || String(err)) : '';
      if (msg.includes('Parse error') || msg.includes('PartialReadError') || msg.includes('array size is abnormally large')) {
        return; // Mengabaikan warning paket item kustom server agar bot tetap stabil
      }
      this.logSystem(`[ERROR] 🚨 Bot error: ${msg}`);
      if (err && err.stack) this.logSystem(`[ERROR] Stack trace:\n${err.stack}`);
    });

    this.bot.on('end', (reason) => {
      this.logSystem(`[END] 🛑 Koneksi bot terputus (${reason || 'end event'})`);
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.antiAfk.stop();
      this.farmHelper.stopAutoAttack();
      this.updateStatus('DISCONNECTED');
      this.bot = null;
      if (!this.manualStop) {
        this.scheduleReconnect(5000);
      }
    });
  }

  triggerWalkTest() {
    if (!this.bot || !this.bot.entity) return;
    if (this.walkTestExecuted) return;
    this.walkTestExecuted = true;

    const startPos = this.bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const distance = 50;
    const targetX = Math.floor(startPos.x + distance * Math.cos(angle));
    const targetZ = Math.floor(startPos.z + distance * Math.sin(angle));

    this.logSystem(`[WALK TEST 🏃] Bot berhasil masuk server! Memulai uji jalan 50 block dari (${startPos.x.toFixed(0)}, ${startPos.z.toFixed(0)}) menuju (${targetX}, ${targetZ})...`);

    try {
      if (!this.bot.pathfinder) {
        this.logSystem(`[WALK TEST ⚠️] Pathfinder plugin belum dimuat.`);
        return;
      }

      const defaultMove = new Movements(this.bot);
      this.bot.pathfinder.setMovements(defaultMove);
      this.bot.pathfinder.setGoal(new goals.GoalXZ(targetX, targetZ));

      const onGoalReached = () => {
        if (!this.bot || !this.bot.entity) return;
        const endPos = this.bot.entity.position;
        this.logSystem(`[WALK TEST ✅] UJI JALAN BERHASIL! Bot berhasil berjalan 50 block ke (${endPos.x.toFixed(0)}, ${endPos.z.toFixed(0)}). Bot bebas dari plugin freeze/kick server & siap IDLE!`);
        if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
      };

      this.bot.once('goal_reached', onGoalReached);

      // Timeout 45 detik jika jalan terhalang atau daerah tidak bisa dimasuki
      setTimeout(() => {
        if (this.bot && this.bot.entity) {
          const currentPos = this.bot.entity.position;
          this.logSystem(`[WALK TEST ⏱️] Uji jalan selesai (Timeout 45 detik). Posisi bot saat ini: (${currentPos.x.toFixed(0)}, ${currentPos.z.toFixed(0)}). Bot IDLE.`);
          if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
        }
      }, 45000);
    } catch (err) {
      this.logSystem(`[WALK TEST ⚠️] Gagal memulai pathfinder uji jalan: ${err.message}`);
    }
  }

  sendServerCommand(cmd) {
    if (!this.bot) return;
    const formattedCmd = cmd.startsWith('/') ? cmd : '/' + cmd;
    try {
      this.bot.chat(formattedCmd);
    } catch (e) {
      // Abaikan error saat bot sedang transisi koneksi
    }
  }

  detectAndPerformLogin(messageStr) {
    const lower = messageStr.toLowerCase();

    // Deteksi pesan Session Expired / IP berubah — paksa reset auth dan kirim ulang login
    if (lower.includes('session data has expired') || lower.includes('ip has been changed') ||
        lower.includes('session expired') || lower.includes('ip changed')) {
      this.isAuthenticated = false;
      this.logSystem(`[AUTH ⚠️] Server menolak sesi lama (IP berubah). Mengirim ulang /login...`);
      const al = this.config.autoLogin;
      if (al && al.enabled && al.password) {
        setTimeout(() => {
          if (this.bot && !this.isAuthenticated) {
            this.bot.chat(`/login ${al.password}`);
          }
        }, 500);
      }
      return;
    }

    // Deteksi pesan sukses login (Session Reconnection / plugin auth berhasil)
    // HAPUS "welcome back" / "selamat datang" karena itu sering dari Essentials MOTD
    // yang terkirim SEBELUM AuthMe selesai, menyebabkan false-positive!
    if (lower.includes('successful login') || lower.includes('successfully logged in') ||
        lower.includes('logged-in') || lower.includes('logged in') ||
        lower.includes('berhasil login')) {
      if (!this.isAuthenticated) {
        this.logSystem(`[AUTH ✅] Login berhasil terdeteksi! (Pemicu: "${messageStr.trim()}")`);
        this.isAuthenticated = true;

        // TARGET 1 & 2: Chat "hallo bang" satu kali saat berhasil login sepenuhnya
        if (!this.hasSaidHello) {
          this.hasSaidHello = true;
          setTimeout(() => {
            if (this.bot && this.moveState !== 'DISCONNECTED') {
              this.logSystem(`[CHAT] Mengirim pesan sapaan "hallo bang"...`);
              this.bot.chat("hallo bang");
              
              // Tambahan: Auto-follow Rendy1125
              setTimeout(() => {
                if (!this.bot || this.moveState !== 'IDLE') return;
                const targetName = 'Rendy1125';
                let targetEntity = null;
                
                // Cari dari entitas terdekat
                if (this.bot.entities) {
                  for (const id in this.bot.entities) {
                    const ent = this.bot.entities[id];
                    if (ent && ent.type === 'player' && ent.username === targetName) {
                      targetEntity = ent;
                      break;
                    }
                  }
                }
                
                if (targetEntity) {
                  this.logSystem(`[AUTO-FOLLOW] Pemain ${targetName} ditemukan! Mulai mengikuti...`);
                  this.moveState = 'FOLLOWING';
                  try {
                    if (this.bot.pathfinder) {
                      const mcData = require('minecraft-data')(this.bot.version);
                      const defaultMove = new Movements(this.bot, mcData);
                      defaultMove.canDig = false; // Hindari bot menggali blok sembarangan saat jalan
                      defaultMove.allowParkour = false; // Matikan lompat parkour ekstrem agar tidak di-kick Anti-Cheat
                      defaultMove.allowSprinting = false; // Matikan lari (sprint) agar gerakan lebih natural
                      this.bot.pathfinder.setMovements(defaultMove);
                      this.bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 2), true); // Jarak 2 block lebih aman
                    }
                  } catch(e) {
                     this.logSystem(`[ERROR] Gagal auto-follow: ${e.message}`);
                     this.moveState = 'IDLE';
                  }
                } else {
                  this.logSystem(`[AUTO-FOLLOW] Pemain ${targetName} tidak ditemukan di sekitar. Batal mengikuti.`);
                }
              }, 1500); // Jeda 1.5 detik setelah chat
            }
          }, 2000); // Tunggu sebentar setelah login sukses sebelum chat
        }
      }
      return;
    }

    if (this.isAuthenticated) return;

    const now = Date.now();
    if (now - this.lastLoginAttempt < 3000) return;

    // Deteksi prompt login / register dari server
    const isRegisterPrompt = lower.includes('/register ') || lower.includes('please register') ||
      lower.includes('not registered') || lower.includes('belum terdaftar') ||
      (lower.includes('register') && !lower.includes('registered'));

    const isLoginPrompt = lower.includes('/login ') || lower.includes('please login') ||
      lower.includes('please log in') || lower.includes('masukan password') ||
      lower.includes('you need to login') || lower.includes('not logged in') ||
      lower.includes('please authenticate');

    if (isRegisterPrompt || isLoginPrompt) {
      this.lastLoginAttempt = now;
      const al = this.config.autoLogin;
      if (al && al.enabled && al.password) {
        if (isRegisterPrompt) {
          this.logSystem(`[AUTH 🔑] Server meminta register, mengirim /register...`);
          this.bot.chat(`/register ${al.password} ${al.password}`);
        } else {
          this.logSystem(`[AUTH 🔑] Server meminta login, mengirim /login...`);
          this.bot.chat(`/login ${al.password}`);
        }
      } else {
        this.logSystem(`[INFO LOGIN] Server meminta autentikasi. Silakan ketik perintah pada Live Chat Console.`);
      }
    }
  }

  scheduleReconnect(customDelay = null) {
    if (this.manualStop) return;
    if (!this.config.server.autoReconnect) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const delay = customDelay !== null ? customDelay : (this.config.server.reconnectIntervalMs || 5000);
    this.logSystem(`Akan menghubungkan ulang otomatis dalam ${delay / 1000} detik...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  updateStatus(newStatus) {
    this.status = newStatus;
    this.emit('status', this.status);
    this.emitState();
  }

  logSystem(text) {
    const item = {
      type: 'syslog',
      sender: 'BOT',
      text: text,
      time: new Date().toLocaleTimeString()
    };
    console.log(`[${item.time}] [SYSTEM] ${text}`);
    this.addLog(item);
    this.emit('chat', item);
  }

  addLog(item) {
    this.chatLogs.push(item);
    if (this.chatLogs.length > this.maxLogs) {
      this.chatLogs.shift();
    }
  }

  getInventory() {
    if (!this.bot || !this.bot.inventory) return [];
    try {
      return this.bot.inventory.items().map(item => ({
        name: item.name,
        displayName: item.displayName,
        count: item.count,
        slot: item.slot
      }));
    } catch (err) {
      return [];
    }
  }

  getBotState() {
    const isOnline = this.status === 'ONLINE' && this.bot && this.bot.entity;
    return {
      status: this.status,
      server: {
        host: this.config.server.host,
        port: this.config.server.port,
        username: this.config.server.username,
        version: this.config.server.version || '1.21.11'
      },
      health: isOnline ? Math.round(this.bot.health || 0) : 0,
      food: isOnline ? Math.round(this.bot.food || 0) : 0,
      position: isOnline ? {
        x: Math.round(this.bot.entity.position.x),
        y: Math.round(this.bot.entity.position.y),
        z: Math.round(this.bot.entity.position.z)
      } : { x: 0, y: 0, z: 0 },
      features: {
        antiAfk: this.antiAfk ? this.antiAfk.isRunning : false,
        autoEat: this.autoEat ? this.autoEat.enabled : false,
        autoAttack: this.farmHelper ? this.farmHelper.autoAttackEnabled : false
      },
      inventory: isOnline ? this.getInventory() : []
    };
  }

  emitState() {
    this.emit('state', this.getBotState());
  }

  sendChat(message) {
    if (this.bot && this.status === 'ONLINE') {
      if (message.startsWith('/')) {
        this.sendServerCommand(message);
      } else {
        this.bot.chat(message);
      }
      this.logSystem(`[Pesan Terkirim] ${message}`);
    }
  }

  updateConfig(newConfig) {
    if (newConfig.server) Object.assign(this.config.server, newConfig.server);
    if (newConfig.antiAfk) {
      Object.assign(this.config.antiAfk, newConfig.antiAfk);
      this.antiAfk.setEnabled(this.config.antiAfk.enabled);
    }
    if (newConfig.autoEat) {
      Object.assign(this.config.autoEat, newConfig.autoEat);
      this.autoEat.setEnabled(this.config.autoEat.enabled);
    }
    if (newConfig.farm) {
      Object.assign(this.config.farm, newConfig.farm);
      if (this.config.farm.autoAttack) {
        this.farmHelper.startAutoAttack();
      } else {
        this.farmHelper.stopAutoAttack();
      }
    }
    this.emitState();
  }
}

module.exports = BotManager;

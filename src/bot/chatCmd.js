const { Movements, goals } = require('mineflayer-pathfinder');
const GoalFollow = goals.GoalFollow;

/**
 * Modul Chat Commands untuk merespon perintah in-game dari player
 * Semua balasan dikirimkan secara privat melalui whisper /w ke pemain yang memberikan perintah.
 */
class ChatCommandHandler {
  constructor(botManager) {
    this.botManager = botManager;
    this.bot = null;
    this.ownerUsername = (botManager.config.owner && botManager.config.owner.username)
      ? botManager.config.owner.username.toLowerCase()
      : null;
  }

  init(bot) {
    this.bot = bot;

    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return;
      this.handleCommand(username, message, false);
    });

    this.bot.on('whisper', (username, message) => {
      if (username === this.bot.username) return;
      this.handleCommand(username, message, true);
    });
  }

  // Parse custom Spigot / Essentials whisper formats from messagestr
  handleRawMessage(rawMessage) {
    if (!rawMessage || !rawMessage.includes('!')) return;

    const parsed = this.parseSenderFromMessage(rawMessage);
    if (parsed && parsed.sender && parsed.sender !== this.bot.username) {
      this.handleCommand(parsed.sender, parsed.text, parsed.isWhisper);
    }
  }

  parseSenderFromMessage(rawMessage) {
    const clean = rawMessage.trim();

    // Format 1: "[Sender -> MamaMia] !follow" or "[Sender -> me] !follow"
    let m = clean.match(/^\[([a-zA-Z0-9_]{2,16})\s*->\s*[^\]]+\]\s*(.+)$/);
    if (m) return { sender: m[1], text: m[2], isWhisper: true };

    // Format 2: "From Sender: !follow" or "Sender whispers: !follow"
    m = clean.match(/^(?:From|Dari)?\s*([a-zA-Z0-9_]{2,16})\s*(?:whispers|bisik|->|:)\s*(?:to you|ke anda)?\s*:?\s*(.+)$/i);
    if (m) return { sender: m[1], text: m[2], isWhisper: true };

    // Format 3: "<Sender> !follow"
    m = clean.match(/^<([a-zA-Z0-9_]{2,16})>\s*(.+)$/);
    if (m) return { sender: m[1], text: m[2], isWhisper: false };

    // Format 4: "Sender: !follow"
    m = clean.match(/^([a-zA-Z0-9_]{2,16}):\s*(!.+)$/);
    if (m) return { sender: m[1], text: m[2], isWhisper: false };

    return null;
  }

  findPlayerEntity(targetUsername) {
    if (!this.bot) return null;
    const lowerName = targetUsername.toLowerCase();

    // 1. Search rendered entities in world
    if (this.bot.entities) {
      for (const id in this.bot.entities) {
        const entity = this.bot.entities[id];
        if (entity && entity.type === 'player' && entity.username && entity.username.toLowerCase() === lowerName) {
          return entity;
        }
      }
    }

    // 2. Search bot.players fallback
    if (this.bot.players) {
      for (const playerName in this.bot.players) {
        if (playerName.toLowerCase() === lowerName) {
          const playerObj = this.bot.players[playerName];
          if (playerObj && playerObj.entity) return playerObj.entity;
        }
      }
    }

    return null;
  }

  handleCommand(username, message, isWhisper = false) {
    const text = message.trim();
    if (!text.startsWith('!')) return;

    // Cek apakah pengirim adalah owner yang sah — abaikan semua player lain
    if (this.ownerUsername && username.toLowerCase() !== this.ownerUsername) return;

    const args = text.slice(1).split(' ');
    const command = args[0].toLowerCase();

    // Selalu balas via whisper rahasia (/w <username>) agar tidak terlihat di chat publik
    const reply = (msg) => {
      this.botManager.sendServerCommand(`/w ${username} ${msg}`);
    };

    switch (command) {
      case 'status': {
        const health = Math.round(this.bot.health || 0);
        const food = Math.round(this.bot.food || 0);
        const pos = this.bot.entity ? this.bot.entity.position : { x: 0, y: 0, z: 0 };
        const x = Math.round(pos.x);
        const y = Math.round(pos.y);
        const z = Math.round(pos.z);
        reply(`HP: ${health}/20 | Hunger: ${food}/20 | Pos: X:${x} Y:${y} Z:${z}`);
        break;
      }

      case 'eat': {
        if (this.botManager.autoEat) {
          this.botManager.autoEat.eatNow();
          reply(`Aku sedang makan...`);
        }
        break;
      }

      case 'afk': {
        const sub = args[1] ? args[1].toLowerCase() : 'toggle';
        if (this.botManager.antiAfk) {
          if (sub === 'on') {
            this.botManager.antiAfk.setEnabled(true);
            reply(`Anti-AFK diaktifkan`);
          } else if (sub === 'off') {
            this.botManager.antiAfk.setEnabled(false);
            reply(`Anti-AFK dimatikan`);
          } else {
            const newState = !this.botManager.antiAfk.isRunning;
            this.botManager.antiAfk.setEnabled(newState);
            reply(`Anti-AFK ${newState ? 'diaktifkan' : 'dimatikan'}`);
          }
        }
        break;
      }

      // --- DEBUGGING COMMANDS ---
      case 'ping': {
        this.botManager.logSystem(`[COMMAND] !ping diterima dari ${username}`);
        reply(`pong`);
        break;
      }

      case 'saytest': {
        this.botManager.logSystem(`[COMMAND] !saytest diterima dari ${username}`);
        reply(`movement test ready`);
        break;
      }

      case 'movetest': {
        this.botManager.logSystem(`[COMMAND] !movetest diterima dari ${username}. Uji gerak murni...`);
        reply(`Menguji pergerakan dasar 2 detik...`);
        this.botManager.moveState = 'MOVING';
        
        try {
          this.bot.setControlState('forward', true);
          setTimeout(() => {
            if (this.bot) this.bot.setControlState('forward', false);
            this.botManager.moveState = 'IDLE';
            this.botManager.logSystem(`[COMMAND] !movetest selesai. State = IDLE`);
            reply(`Uji pergerakan selesai.`);
          }, 2000);
        } catch (err) {
          this.botManager.logSystem(`[ERROR] movetest gagal: ${err.message}`);
          this.botManager.moveState = 'IDLE';
        }
        break;
      }

      case 'testpath': {
        this.botManager.logSystem(`[COMMAND] !testpath diterima dari ${username}. Uji Pathfinder jarak dekat...`);
        if (!this.bot.entity) break;
        
        const pos = this.bot.entity.position;
        const targetX = Math.floor(pos.x + 3);
        const targetZ = Math.floor(pos.z + 3);
        
        this.botManager.moveState = 'MOVING';
        this.botManager.logSystem(`[PATHFINDER] Mencoba setGoal ke (${targetX}, ${pos.y}, ${targetZ})...`);
        
        try {
          if (this.bot.pathfinder) {
            const defaultMove = new Movements(this.bot);
            this.bot.pathfinder.setMovements(defaultMove);
            
            const startTime = process.hrtime();
            this.bot.pathfinder.setGoal(new goals.GoalXZ(targetX, targetZ));
            const diff = process.hrtime(startTime);
            const ms = (diff[0] * 1e9 + diff[1]) / 1e6;
            
            this.botManager.logSystem(`[PATHFINDER] setGoal selesai dalam ${ms.toFixed(2)} ms.`);
            reply(`Menjalankan pathfinder uji dekat...`);
            
            this.bot.once('goal_reached', () => {
              this.botManager.logSystem(`[GOAL REACHED] Uji jalan pendek tercapai.`);
              this.botManager.moveState = 'IDLE';
            });
          }
        } catch(err) {
          this.botManager.logSystem(`[ERROR] testpath gagal: ${err.message}`);
          this.botManager.moveState = 'IDLE';
        }
        break;
      }

      case 'follow':
      case 'come': {
        this.botManager.logSystem(`[WHISPER] ${username} -> !follow`);
        this.botManager.logSystem(`[COMMAND] FOLLOW mulai`);
        const targetUsername = args[1] || username;
        const targetEntity = this.findPlayerEntity(targetUsername);

        if (!targetEntity) {
          this.botManager.logSystem(`[FOLLOW] Target ${targetUsername} tidak ditemukan di render distance.`);
          reply(`Aku tidak bisa melihat kamu, coba berdiri lebih dekat ya`);
          break;
        }

        const p = targetEntity.position;
        this.botManager.logSystem(`[FOLLOW] Target ditemukan: x=${Math.round(p.x)} y=${Math.round(p.y)} z=${Math.round(p.z)}`);
        this.botManager.moveState = 'FOLLOWING';

        try {
          if (this.bot.pathfinder) {
            this.botManager.logSystem(`[PATHFINDER] GoalFollow dibuat`);
            const defaultMove = new Movements(this.bot);
            this.bot.pathfinder.setMovements(defaultMove);
            
            const startTime = process.hrtime();
            this.botManager.logSystem(`[PATHFINDER] Sebelum setGoal...`);
            this.bot.pathfinder.setGoal(new GoalFollow(targetEntity, 1), true);
            const diff = process.hrtime(startTime);
            const ms = (diff[0] * 1e9 + diff[1]) / 1e6;
            this.botManager.logSystem(`[PATHFINDER] Setelah setGoal (Waktu kalkulasi: ${ms.toFixed(2)} ms)`);

            reply(`Aku mengikuti kamu`);
          }
        } catch (err) {
          this.botManager.logSystem(`[ERROR] Gagal mengikuti: ${err.message}`);
          this.botManager.moveState = 'IDLE';
          reply(`Gagal mengikuti: ${err.message}`);
        }
        break;
      }

      case 'stop':
      case 'stopfollow': {
        this.botManager.logSystem(`[COMMAND] !stop diterima. Menghapus semua command pergerakan.`);
        try {
          if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null);
          }
          this.bot.clearControlStates(); // Hentikan forward, back, sprint, jump, dll
        } catch(e) {}
        this.botManager.moveState = 'IDLE';
        reply(`Aku berhenti mengikuti kamu dan kembali IDLE`);
        break;
      }

      case 'drop': {
        if (this.botManager.farmHelper) {
          this.botManager.farmHelper.dropTrashItems();
          reply(`Aku sudah membuang item sampah`);
        }
        break;
      }

      case 'dropall': {
        if (this.botManager.farmHelper) {
          this.botManager.farmHelper.dropAllItems();
          reply(`Aku sudah membuang semua item`);
        }
        break;
      }

      case 'say': {
        const msgToSay = args.slice(1).join(' ');
        if (msgToSay) {
          this.bot.chat(msgToSay);
        }
        break;
      }

      case 'help': {
        reply(`Perintah: !status, !follow, !stop, !eat, !afk, !drop, !dropall`);
        break;
      }
    }
  }
}

module.exports = ChatCommandHandler;

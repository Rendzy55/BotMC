/**
 * Modul Anti-AFK untuk mencegah bot ditendang oleh server
 */
class AntiAfkManager {
  constructor(config) {
    this.config = config || {};
    this.timer = null;
    this.bot = null;
    this.isRunning = false;
  }

  init(bot, botManager) {
    this.bot = bot;
    this.botManager = botManager; // referensi ke mcBot.js
    if (this.config.enabled) {
      this.start();
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const interval = this.config.intervalMs || 8000;

    this.timer = setInterval(() => {
      if (!this.bot || !this.bot.entity) return;

      // Jangan ganggu pergerakan bot jika pathfinder sedang aktif berjalan atau bot sedang bergerak
      if (this.botManager && this.botManager.moveState !== 'IDLE') {
        return;
      }
      
      if (this.bot.pathfinder && typeof this.bot.pathfinder.isMoving === 'function' && this.bot.pathfinder.isMoving()) {
        return;
      }

      try {
        // 1. Swing arm (gerakan tangan ringan)
        if (this.config.swingArm !== false) {
          this.bot.swingArm('mainhand');
        }

        // 2. Head rotation (rotasi kepala acak alami)
        if (this.config.headRotation !== false) {
          const currentYaw = this.bot.entity.yaw || 0;
          const deltaYaw = (Math.random() * 0.6) - 0.3; // Rotasi kecil, tidak drastis
          const pitch = (Math.random() * 0.2) - 0.1;
          this.bot.look(currentYaw + deltaYaw, pitch, true);
        }

        // 3. Small movement / jump (tanpa sneak agar bot tidak berjalan sangat lambat/freeze)
        if (this.config.smallMovement) {
          const randomAction = Math.random();
          if (randomAction < 0.25) {
            this.bot.setControlState('jump', true);
            setTimeout(() => {
              if (this.bot) this.bot.setControlState('jump', false);
            }, 200);
          }
        }
      } catch (err) {
        console.error('[AntiAFK Error]', err.message);
      }
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bot) {
      try {
        this.bot.clearControlStates();
      } catch (e) {}
    }
    this.isRunning = false;
  }

  setEnabled(enabled) {
    this.config.enabled = enabled;
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
  }
}

module.exports = AntiAfkManager;

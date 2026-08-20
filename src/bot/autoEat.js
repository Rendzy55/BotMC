/**
 * Modul Auto-Eat menggunakan mineflayer-auto-eat (ESM compatible)
 */
class AutoEatManager {
  constructor(config) {
    this.config = config || {};
    this.bot = null;
    this.enabled = this.config.enabled !== false;
  }

  async init(bot) {
    this.bot = bot;
    try {
      // Dynamic import untuk kompatibilitas ES Module
      const autoEatModule = await import('mineflayer-auto-eat');
      const autoEatPlugin = autoEatModule.default || autoEatModule.plugin || autoEatModule;

      if (typeof autoEatPlugin === 'function') {
        this.bot.loadPlugin(autoEatPlugin);
      }

      this.bot.once('spawn', () => {
        if (this.bot.autoEat) {
          this.bot.autoEat.options = {
            priority: this.config.priority || 'foodPoints',
            bannedFood: this.config.bannedFood || ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'],
            checkInterval: 2000
          };
          if (this.enabled) {
            this.bot.autoEat.enable();
          } else {
            this.bot.autoEat.disable();
          }
        }
      });
    } catch (err) {
      console.warn('[AutoEat Warning] Failed loading plugin, using fallback listener:', err.message);
      this.setupFallback();
    }
  }

  setupFallback() {
    if (!this.bot) return;
    this.bot.on('health', () => {
      if (!this.enabled) return;
      if (this.bot.food < 15) {
        this.eatNow();
      }
    });
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.bot && this.bot.autoEat) {
      if (enabled) {
        this.bot.autoEat.enable();
      } else {
        this.bot.autoEat.disable();
      }
    }
  }

  async eatNow() {
    if (!this.bot) return;
    if (this.bot.autoEat && typeof this.bot.autoEat.eat === 'function') {
      try {
        this.bot.autoEat.eat();
        return;
      } catch (e) {}
    }

    // Manual eat fallback: cari item makanan di inventory/hotbar
    try {
      const foodItems = this.bot.inventory.items().filter(item => {
        const banned = this.config.bannedFood || ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'];
        return item.name.includes('cooked') || item.name.includes('bread') || item.name.includes('apple') ||
               item.name.includes('steak') || item.name.includes('porkchop') || item.name.includes('carrot') && !banned.includes(item.name);
      });

      if (foodItems.length > 0) {
        const food = foodItems[0];
        await this.bot.equip(food, 'hand');
        this.bot.activateItem();
      }
    } catch (err) {
      // Ignore manual eat errors
    }
  }
}

module.exports = AutoEatManager;

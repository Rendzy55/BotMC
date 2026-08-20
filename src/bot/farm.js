/**
 * Modul Farm Helper: Auto-Attack (Mob Grinder) & Auto-Drop Trash Items
 */
class FarmHelper {
  constructor(config) {
    this.config = config || {};
    this.bot = null;
    this.attackInterval = null;
    this.autoAttackEnabled = this.config.autoAttack || false;
    this.autoDropTrashEnabled = this.config.autoDropTrash || false;
    this.trashItems = this.config.trashItems || ['cobblestone', 'dirt', 'gravel', 'rotten_flesh'];
  }

  init(bot) {
    this.bot = bot;

    this.bot.on('spawn', () => {
      if (this.autoAttackEnabled) {
        this.startAutoAttack();
      }
    });

    // Event listener saat inventory berubah
    this.bot.on('playerCollect', () => {
      if (this.autoDropTrashEnabled) {
        setTimeout(() => this.dropTrashItems(), 1000);
      }
    });
  }

  startAutoAttack(intervalMs) {
    if (this.attackInterval) clearInterval(this.attackInterval);
    this.autoAttackEnabled = true;
    const interval = intervalMs || this.config.autoAttackIntervalMs || 1000;

    this.attackInterval = setInterval(() => {
      if (!this.bot || !this.bot.entity) return;

      try {
        // Cari entity monster / mob terdekat dalam radius 3.5 block
        const target = this.bot.nearestEntity((entity) => {
          return entity.type === 'mob' &&
                 entity.position.distanceTo(this.bot.entity.position) < 4.0;
        });

        if (target) {
          this.bot.attack(target);
        } else {
          // Jika tidak ada target, lakukan swing arm saja (auto-clicker)
          this.bot.swingArm('mainhand');
        }
      } catch (err) {
        // Ignore entity attack delay errors
      }
    }, interval);
  }

  stopAutoAttack() {
    this.autoAttackEnabled = false;
    if (this.attackInterval) {
      clearInterval(this.attackInterval);
      this.attackInterval = null;
    }
  }

  async dropTrashItems() {
    if (!this.bot || !this.bot.inventory) return;

    try {
      const items = this.bot.inventory.items();
      for (const item of items) {
        if (this.trashItems.includes(item.name)) {
          await this.bot.tossStack(item);
        }
      }
    } catch (err) {
      console.error('[FarmDrop Error]', err.message);
    }
  }

  async dropAllItems() {
    if (!this.bot || !this.bot.inventory) return;

    try {
      const items = this.bot.inventory.items();
      for (const item of items) {
        await this.bot.tossStack(item);
      }
    } catch (err) {
      console.error('[DropAll Error]', err.message);
    }
  }
}

module.exports = FarmHelper;

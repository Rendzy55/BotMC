const socket = io();

// DOM Elements
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const healthVal = document.getElementById('healthVal');
const healthBar = document.getElementById('healthBar');
const foodVal = document.getElementById('foodVal');
const foodBar = document.getElementById('foodBar');
const serverVal = document.getElementById('serverVal');
const botNameVal = document.getElementById('botNameVal');
const posVal = document.getElementById('posVal');

const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnDropTrash = document.getElementById('btnDropTrash');
const btnDropAll = document.getElementById('btnDropAll');

const chkAntiAfk = document.getElementById('chkAntiAfk');
const chkAutoEat = document.getElementById('chkAutoEat');
const chkAutoAttack = document.getElementById('chkAutoAttack');

const configForm = document.getElementById('configForm');
const cfgHost = document.getElementById('cfgHost');
const cfgPort = document.getElementById('cfgPort');
const cfgUsername = document.getElementById('cfgUsername');
const cfgVersion = document.getElementById('cfgVersion');
const chkAutoLogin = document.getElementById('chkAutoLogin');
const cfgPassword = document.getElementById('cfgPassword');

const chatLogs = document.getElementById('chatLogs');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const inventoryGrid = document.getElementById('inventoryGrid');
const btnPresetLocal = document.getElementById('btnPresetLocal');
const btnPresetOnline = document.getElementById('btnPresetOnline');

// Menyimpan data preset online dari server config
let onlinePreset = {
  host: 'nolife.raznar.net',
  port: 25054,
  username: 'MamaMia',
  version: '1.21.11'
};

// Handle State Updates
socket.on('state', (state) => {
  updateUIState(state);
});

socket.on('status', (status) => {
  updateStatusBadge(status);
});

socket.on('chatLogs', (logs) => {
  chatLogs.innerHTML = '';
  logs.forEach(log => appendLog(log));
  chatLogs.scrollTop = chatLogs.scrollHeight;
});

socket.on('chat', (log) => {
  appendLog(log);
  chatLogs.scrollTop = chatLogs.scrollHeight;
});

function updateUIState(state) {
  updateStatusBadge(state.status);

  // Server & Bot Info
  serverVal.textContent = `${state.server.host}:${state.server.port}`;
  botNameVal.textContent = state.server.username;

  // Sync config ke form UI, TAPI jangan timpa jika user sedang mengetik di input tersebut
  if (document.activeElement !== cfgHost) cfgHost.value = state.server.host || '';
  if (document.activeElement !== cfgPort) cfgPort.value = state.server.port || '';
  if (document.activeElement !== cfgUsername) cfgUsername.value = state.server.username || '';
  if (document.activeElement !== cfgVersion) cfgVersion.value = state.server.version || '1.21.11';

  // Simpan nilai server online ke memori preset jika bukan localhost
  if (state.server.host !== 'localhost' && state.server.host !== '127.0.0.1') {
    onlinePreset = {
      host: state.server.host,
      port: state.server.port,
      username: state.server.username,
      version: state.server.version || '1.21.11'
    };
    // Tampilkan nama server di tombol preset online
    btnPresetOnline.textContent = `🌐 ${state.server.host}`;
  }

  if (state.autoLogin) {
    if (document.activeElement !== chkAutoLogin) chkAutoLogin.checked = !!state.autoLogin.enabled;
    if (document.activeElement !== cfgPassword) cfgPassword.value = state.autoLogin.password || '';
  }

  // Health Bar
  const hp = state.health || 0;
  healthVal.textContent = `${hp}/20`;
  healthBar.style.width = `${(hp / 20) * 100}%`;

  // Hunger Bar
  const food = state.food || 0;
  foodVal.textContent = `${food}/20`;
  foodBar.style.width = `${(food / 20) * 100}%`;

  // Position
  if (state.position) {
    posVal.textContent = `X: ${state.position.x}, Y: ${state.position.y}, Z: ${state.position.z}`;
  }

  // Toggles
  if (state.features) {
    chkAntiAfk.checked = !!state.features.antiAfk;
    chkAutoEat.checked = !!state.features.autoEat;
    chkAutoAttack.checked = !!state.features.autoAttack;
  }

  // Inventory
  renderInventory(state.inventory || []);
}

function updateStatusBadge(status) {
  statusBadge.className = `status-badge ${status}`;
  statusText.textContent = status;
}

function appendLog(log) {
  const div = document.createElement('div');
  div.className = `log-item ${log.type || 'chat'}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = `[${log.time || '00:00:00'}] `;

  div.appendChild(timeSpan);

  if (log.type === 'chat' || log.type === 'whisper') {
    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender';
    senderSpan.textContent = `<${log.sender}> `;
    div.appendChild(senderSpan);
  } else if (log.sender) {
    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender';
    senderSpan.textContent = `[${log.sender}] `;
    div.appendChild(senderSpan);
  }

  const textNode = document.createTextNode(log.text);
  div.appendChild(textNode);

  chatLogs.appendChild(div);
}

function renderInventory(items) {
  if (!items || items.length === 0) {
    inventoryGrid.innerHTML = '<p class="empty-inv">Inventory kosong / Bot offline.</p>';
    return;
  }

  inventoryGrid.innerHTML = '';
  items.forEach(item => {
    const slot = document.createElement('div');
    slot.className = 'inv-slot';
    slot.innerHTML = `
      <span class="count">${item.count}</span>
      <div>${item.displayName || item.name}</div>
    `;
    inventoryGrid.appendChild(slot);
  });
}

// User Actions
btnStart.addEventListener('click', () => {
  socket.emit('startBot');
});

btnStop.addEventListener('click', () => {
  socket.emit('stopBot');
});

chkAntiAfk.addEventListener('change', (e) => {
  socket.emit('toggleAntiAfk', e.target.checked);
});

chkAutoEat.addEventListener('change', (e) => {
  socket.emit('toggleAutoEat', e.target.checked);
});

chkAutoAttack.addEventListener('change', (e) => {
  socket.emit('toggleAutoAttack', e.target.checked);
});

btnDropTrash.addEventListener('click', () => {
  socket.emit('dropTrash');
});

btnDropAll.addEventListener('click', () => {
  socket.emit('dropAll');
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text) {
    socket.emit('sendChat', text);
    chatInput.value = '';
  }
});

configForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const newConfig = {
    server: {
      host: cfgHost.value.trim(),
      port: parseInt(cfgPort.value),
      username: cfgUsername.value.trim(),
      version: cfgVersion.value.trim() || '1.21.11'
    },
    autoLogin: {
      enabled: chkAutoLogin.checked,
      password: cfgPassword.value.trim()
    }
  };
  socket.emit('updateConfig', newConfig);
  alert('Konfigurasi server & Auto-Login berhasil diperbarui!');
});
// Preset Localhost
btnPresetLocal.addEventListener('click', () => {
  cfgHost.value = 'localhost';
  cfgPort.value = '25565';
  cfgUsername.value = cfgUsername.value || 'Bot_AFK';
  cfgVersion.value = '1.21.11';
  chkAutoLogin.checked = false;
  cfgPassword.value = '';

  btnPresetLocal.classList.add('active-preset');
  btnPresetOnline.classList.remove('active-preset');
});

// Preset Online Server
btnPresetOnline.addEventListener('click', () => {
  cfgHost.value = onlinePreset.host;
  cfgPort.value = onlinePreset.port;
  cfgUsername.value = onlinePreset.username;
  cfgVersion.value = onlinePreset.version;

  btnPresetOnline.classList.add('active-preset');
  btnPresetLocal.classList.remove('active-preset');
});

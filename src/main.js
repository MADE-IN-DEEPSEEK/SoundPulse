const { app, BrowserWindow, ipcMain, globalShortcut, dialog, session, shell, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const IS_SMOKE = process.env.SMOKE === '1';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    registerAll();
    const main = BrowserWindow.getAllWindows()[0];
    if (main) { if (main.isMinimized()) main.restore(); main.focus(); }
  });
} else {
  app.quit();
}

app.setName('SoundPulse');
// Данные приложения: %APPDATA%\SoundPulse. Старая папка PERDBOX (наследие прежнего
// названия) при первом запуске переносится автоматически, чтобы настройки и
// библиотека звуков не пропали.
const DATA_DIR = path.join(app.getPath('appData'), 'SoundPulse');
const LEGACY_DATA_DIR = path.join(app.getPath('appData'), 'PERDBOX');
app.setPath('userData', DATA_DIR);

function migrateUserData() {
  try {
    if (!fs.existsSync(LEGACY_DATA_DIR)) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const files = ['settings.json', 'settings.json.bak', 'settings.json.tmp', 'library.json', 'library.json.bak', 'library.json.tmp'];
    for (const name of files) {
      const from = path.join(LEGACY_DATA_DIR, name);
      const to = path.join(DATA_DIR, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try { fs.copyFileSync(from, to); } catch {}
    }
    dbg('migrate: данные перенесены из PERDBOX в SoundPulse');
  } catch (e) { dbg('migrate fail ' + e.message); }
}

let mainWin = null;
let tray = null;
const DBG = process.env.SP_DEBUG || 1;
function dbg(m) { try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} }
let quitting = false;        // пользователь выбрал «Выйти» — закрываем без диалога
const startedAt = Date.now();
const hotkeyMap = new Map(); // accel -> {type:'sound'|'cmd'|'index', id|cmd|index}
let hotkeySuppressed = false; // true, пока идёт захват новой клавиши в интерфейсе

// Помощники (инжектор PTT и хука клавиатуры) лежат готовыми в build/helpers.
// Раньше они компилировались из C# при каждом запуске — антивирусы очень не любят
// такое поведение. Если готового exe нет (например, при разработке), остаётся
// запасная компиляция во временную папку.
function bundledHelper(name) {
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'helpers'));
  roots.push(path.join(__dirname, '..', 'build', 'helpers'));
  for (const root of roots) {
    const p = path.join(root, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// одинарные буквы/цифры не должны блокироваться глобально (чтобы можно было печатать),
// они работают как локальные хоткеи, только пока окно приложения в фокусе.
function isLocalOnly(accel) {
  if (!accel || accel.includes('+')) return false;
  if (/^F\d{1,2}$/.test(accel)) return false;
  if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'PrintScreen', 'Up', 'Down', 'Left', 'Right'].includes(accel)) return false;
  return true;
}

// ---------------- store ----------------

const DEF_SETTINGS = {
  outputDeviceId: '',      // mic sink (virtual cable)
  speakerDeviceId: '',     // speakers sink ('' = default)
  playMode: 'both',
  masterVolume: 0.25,
  monitorVol: 0.39,
  micEnabled: true,
  monitor: true,
  overlapMode: 'stop',
  allMode: false,
  fartLevel: 0,
  mute: false,
  normalize: false,
  voiceActivation: false,
  ducking: true,
  duckLevel: 0.28,
  passHotkeys: false,
  singleKeysGlobal: false,
  prefixMode: true,
  prefixKey: '\\',
  uiSounds: true,
  pttKey: 'T',  // войс-чат: жми "/" затем T — клавиша T зажмётся в игре (же работают Ctrl/Shift/Alt + буква)
  indexHotkeys: true,
  openAtLogin: false,
  categories: [{ id: 'default', name: 'Звуки' }],
  hotkeys: {},             // soundId -> accelerator
  specialHotkeys: { stop: 'F8' },
  onboarded: false,        // мастер настройки уже пройден
  tourDone: false,         // обучение по использованию уже пройдено
  onboardingRev: 0         // версия пройденного мастера
};

let lib = { sounds: [] };
let settings = { ...DEF_SETTINGS };

function readJson(p) {
  let txt = fs.readFileSync(p, 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1); // BOM от сторонних редакторов
  const j = JSON.parse(txt);
  return j && typeof j === 'object' ? j : null;
}
function loadJson(p, d) {
  try {
    const j = readJson(p);
    if (j) return j;
  } catch {}
  // основной файл битый/недочитанный (например, выключили ПК во время записи) —
  // поднимаем последнюю целую копию
  try {
    const j = readJson(p + '.bak');
    if (j) { dbg('loadJson fallback .bak ' + path.basename(p)); return j; }
  } catch {}
  return d;
}
// запись через временный файл + rename: файл никогда не остаётся наполовину записанным.
// Перед заменой сохраняем предыдущую версию в .bak — это спасает бинды/настройки,
// если приложение упадёт или файл окажется повреждён.
function saveJson(p, o) {
  try {
    const txt = JSON.stringify(o, null, 2);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, txt, 'utf8');
    if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + '.bak'); } catch {} }
    fs.renameSync(tmp, p);
  } catch (e) { dbg('saveJson fail ' + path.basename(p) + ' ' + e.message); }
}
const libFile = () => path.join(app.getPath('userData'), 'library.json');
const setFile = () => path.join(app.getPath('userData'), 'settings.json');

function migrateLegacy() {
  // old app: %APPDATA%\steam-soundpad\config.json
  const old = path.join(app.getPath('appData'), 'steam-soundpad', 'config.json');
  if (!fs.existsSync(old)) return;
  // настройки из легаси применяем ТОЛЬКО когда своего файла ещё нет —
  // иначе старый конфиг перезаписывал бы твой выбор (микрофон/устройства) на каждом старте
  const settingsFileExisted = fs.existsSync(setFile());
  try {
    const o = JSON.parse(fs.readFileSync(old, 'utf8'));
    if (o && Array.isArray(o.sounds) && o.sounds.length && (!lib.sounds || !lib.sounds.length)) {
      lib.sounds = o.sounds
        .map((s) => ({ id: s.id || 's' + Math.random().toString(36).slice(2, 10), name: s.name, category: s.category || '', path: s.path, volume: s.volume != null ? s.volume : 1, rate: 1, offset: 0, fadeIn: 0, fadeOut: 0, loop: false, plays: s.plays || 0, hotkey: s.hotkey || null }))
        .filter((s) => s.path);
      saveJson(libFile(), lib);
    }
    if (settingsFileExisted) return; // свой файл настроек уже есть — легаси ни на что не влияем
    if (typeof o.masterVolume === 'number') settings.masterVolume = o.masterVolume;
    if (o.monitor != null) settings.monitor = !!o.monitor;
    if (o.monitorVol != null) settings.monitorVol = o.monitorVol;
    if (o.micEnabled != null) settings.micEnabled = !!o.micEnabled;
    if (o.overlap != null) settings.overlapMode = o.overlap ? 'overlap' : 'stop';
    if (o.bass != null) settings.fartLevel = o.bass;
    if (o.mute != null) settings.mute = !!o.mute;
    if (o.outputDevice) settings.outputDeviceId = o.outputDevice;
    if (o.speakerDevice) settings.speakerDeviceId = o.speakerDevice === 'default' ? '' : o.speakerDevice;
    if (o.sounds) for (const s of o.sounds) if (s && s.hotkey) settings.hotkeys[s.id || ''] = s.hotkey;
    if (Array.isArray(o.categories)) settings.categories = o.categories
      .map((c) => typeof c === 'string' ? { id: 'c_' + Math.random().toString(36).slice(2, 8), name: c } : { id: c.id || 'c_' + Math.random().toString(36).slice(2, 8), name: c.name })
      .filter((c) => c.name);
    saveJson(setFile(), settings);
  } catch {}
}

// Старые версии сохраняли русские названия не в UTF-8, из-за чего в интерфейсе
// появлялись строки вида «Р—РІСѓРєРё». Лечим такие имена обратным преобразованием.
let cp1251Rev = null;
function cp1251Map() {
  if (cp1251Rev) return cp1251Rev;
  cp1251Rev = new Map();
  try {
    const dec = new TextDecoder('windows-1251');
    for (let b = 0; b < 256; b++) {
      const ch = dec.decode(Uint8Array.of(b));
      if (ch && ch.length === 1 && !cp1251Rev.has(ch)) cp1251Rev.set(ch, b);
    }
  } catch {}
  return cp1251Rev;
}
function repairMojibake(str) {
  if (typeof str !== 'string' || !str || !/[\u0400-\u04FF]/.test(str)) return str;
  const map = cp1251Map();
  const bytes = [];
  for (const ch of str) {
    const b = map.get(ch);
    if (b == null) return str; // не чистый cp1251-набор — не трогаем
    bytes.push(b);
  }
  try {
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    if (fixed && fixed !== str && /[\u0400-\u04FF]/.test(fixed)) return fixed;
  } catch {}
  return str;
}
function repairTextStore() {
  let changed = false;
  const fix = (s) => { const r = repairMojibake(s); if (r !== s) changed = true; return r; };
  if (Array.isArray(settings.categories)) {
    settings.categories = settings.categories.map((c) => (c && c.name ? { ...c, name: fix(c.name) } : c));
  }
  for (const s of lib.sounds || []) if (s && s.name) s.name = fix(s.name);
  if (changed) { dbg('repair: исправлены битые названия'); saveJson(setFile(), settings); saveJson(libFile(), lib); }
}

function loadStore() {
  lib = loadJson(libFile(), { sounds: [] });
  if (!lib.sounds) lib.sounds = [];
  settings = { ...DEF_SETTINGS, ...loadJson(setFile(), {}) };
  migrateLegacy();
  repairTextStore();
  sanitizeHotkeySettings();
  applyLoginItem();
}

// миграция старых/битых акселераторов (Backslash/BracketLeft... -> символы)
function sanitizeHotkeySettings() {
  const SYM = { Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']' };
  const fix = (a) => (typeof a === 'string' && a) ? a.split('+').map((p) => SYM[p] || p).join('+') : a;
  settings.prefixKey = fix(settings.prefixKey) || '\\';
  if (settings.prefixKey === '/') settings.prefixKey = '\\'; // слэш — backslash (справа от Ъ) — это физический \ — это backslash (\), а не /
  if (settings.speakerDeviceId === 'default') settings.speakerDeviceId = '';
  for (const id in settings.hotkeys) settings.hotkeys[id] = fix(settings.hotkeys[id]);
  for (const cmd in settings.specialHotkeys) settings.specialHotkeys[cmd] = fix(settings.specialHotkeys[cmd]);
  settings.pttKey = fixPttKey(settings.pttKey);
}

// войс-чат: либо одиночная буква/цифра/F-клавиша, либо комбинация вида Триггер+Клавиша.
// Клавиша, которую приложение зажимает, — последний токен; триггер (Ctrl/Shift/Alt и тильда `) — сам переключатель.
function fixPttKey(k) {
  const raw = String(k == null ? '' : k).trim().toUpperCase();
  const parts = raw.split('+');
  const isMod = (m) => ['CTRL', 'ALT', 'SHIFT', '`', '~', 'BACKQUOTE', 'TILDE'].includes(m);
  const mods = parts.slice(0, -1).filter(isMod).map((m) => (m === '~' || m === 'TILDE' || m === 'BACKQUOTE' ? '`' : m));
  const base = parts[parts.length - 1];
  if (parts.length === 1) {
    if (/^(F\d{1,2}|[A-Z0-9])$/.test(base)) return base;
    return 'CTRL+SHIFT+T';
  }
  if (!mods.length || !/^(F\d{1,2}|[A-Z0-9])$/.test(base)) return 'CTRL+SHIFT+T';
  return [...new Set(mods)].join('+') + '+' + base;
}

// ---------------- hotkeys ----------------

function sendHotkey(payload) {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('hotkey', payload);
}

function reg(accel, payload) {
  if (!accel) return;
  if (!settings.singleKeysGlobal && isLocalOnly(accel)) { dbg('reg skip-local ' + accel); return; }
  if (hotkeyMap.has(accel)) { dbg('reg skip-dup ' + accel); return; }
  try {
    const ok = globalShortcut.register(accel, () => {
      if (payload.type === 'prefix') { armPrefixKeys(); return; }
      sendHotkey(payload);
    });
    if (ok) hotkeyMap.set(accel, payload);
    else {
      dbg('reg FAIL ' + accel);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('hotkey-error', accel);
    }
    dbg('reg ' + accel + ' ok=' + ok);
  } catch (e) { dbg('reg err ' + accel + ' ' + e.message); }
}

// ---- префиксный режим: жмём "\" (Backslash), затем вторую клавишу ----
// Вторая клавиша регистрируется глобально только на короткое окно после "\",
// поэтому остальное время она не блокирует печать.
let prefixArmed = new Map(); // accel -> payload
let prefixTimer = null;

function armPrefixKeys() {
  disarmPrefixKeys();
  const set = new Map();
  for (const id in settings.hotkeys) set.set(settings.hotkeys[id], { type: 'sound', id });
  for (const cmd in settings.specialHotkeys) set.set(settings.specialHotkeys[cmd], { type: 'cmd', cmd });
  if (settings.pttKey) set.set(settings.pttKey, { type: 'ptt' });
  for (const [accel, payload] of set) {
    if (!accel || accel === settings.prefixKey) continue;
    try {
      const ok = globalShortcut.register(accel, () => {
        disarmPrefixKeys();
        dbg('PREFIXKEY ' + accel);
        if (payload.type === 'ptt') { togglePtt(); return; }
        sendHotkey(payload);
      });
      dbg('arm ' + accel + ' -> ' + ok);
      if (ok) prefixArmed.set(accel, payload);
    } catch {}
  }
  prefixTimer = setTimeout(disarmPrefixKeys, 2500);
}

function disarmPrefixKeys() {
  if (prefixTimer) { clearTimeout(prefixTimer); prefixTimer = null; }
  for (const accel of prefixArmed.keys()) { try { globalShortcut.unregister(accel); } catch {} }
  prefixArmed.clear();
}

// ---- войс-чат (PTT): приложение само зажимает и держит клавишу ----
// Инъекция keybd_event: игра видит базовую клавишу (последний токен комбинации) удержанной.
// Триггер "\" + клавиша (по умолчанию T): жми "\" (Backslash, справа от Ъ) затем клавишу.
let pttHeld = false;

function pttVk(k) {
  k = String(k || '').split('+').pop().trim();
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const f = /^F(\d{1,2})$/i.exec(k);
  if (f && +f[1] >= 1 && +f[1] <= 24) return 0x70 + (+f[1]) - 1;
  return 0;
}
// ---- резидентный инжектор: маленький C#-процесс живёт постоянно, нажатия мгновенные ----
let pttInj = null; // живой инжектор

function ensurePttInjector() {
  if (pttInj && !pttInj.killed && pttInj.exitCode === null && pttInj.stdin && !pttInj.stdin.destroyed) return true;
  const exe = bundledHelper('ptt_inject.exe');
  if (!exe) { dbg('ptt helper not found'); return false; }
  try {
    pttInj = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    pttInj.stdin.on('error', () => {});
    pttInj.stdout.on('data', () => {});
    pttInj.stderr.on('data', () => {});
    pttInj.on('error', () => { pttInj = null; });
    pttInj.on('exit', () => { pttInj = null; });
    return !!pttInj;
  } catch { pttInj = null; return false; }
}
function runPtt(action) {
  const vk = pttVk(settings.pttKey);
  if (!vk) return;
  // Резидентный инжектор: нажатия уходят мгновенно, без запуска новых процессов.
  if (!ensurePttInjector() || !pttInj || !pttInj.stdin || pttInj.stdin.destroyed) {
    dbg('ptt injector unavailable');
    return;
  }
  try { pttInj.stdin.write((action === 'down' ? 'down' : 'up') + ' ' + vk + '\n'); } catch {}
}
function togglePtt() {
  pttHeld = !pttHeld;
  dbg('togglePtt held=' + pttHeld);
  runPtt(pttHeld ? 'down' : 'up');
  sendHotkey({ type: 'ptt', held: pttHeld });
  // НЕ пере-армируем: иначе автоповтор зажатой клавиши T прилетит вторым срабатыванием
  // и мгновенно выключит. Следующее переключение — только через "\" + T.
}
function releasePttIfHeld() {
  if (pttHeld) { pttHeld = false; runPtt('up'); }
}

// ---- префикс без перехвата клавиши: нативный low-level хук ----
// Раньше "\" регистрировался через globalShortcut и всегда съедался, поэтому
// символ нельзя было напечатать. Теперь отдельный маленький C#-процесс ставит
// WH_KEYBOARD_LL: быстрый тап "\" проходит как обычный символ, а удержание
// 450 мс включает режим префикса (следующая клавиша = бинд).


let keyHook = null;
let keyHookPrefix = '';
const KEYHOOK_HOLD_MS = 100;

function keyHookVk(ch) {
  ch = String(ch || '');
  if (!ch) return 0xDC;
  const up = ch.toUpperCase();
  if (/^[A-Z]$/.test(up)) return up.charCodeAt(0);
  if (/^[0-9]$/.test(up)) return up.charCodeAt(0);
  const m = { '\\': 0xDC, '/': 0xBF, ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '`': 0xC0, '[': 0xDB, ']': 0xDD, "'": 0xDE };
  return m[ch] || 0xDC;
}

function vkToAccel(vk) {
  if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x87) return 'F' + (vk - 0x6F);
  const m = {
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: 'Space',
    33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'Left', 38: 'Up',
    39: 'Right', 40: 'Down', 45: 'Insert', 46: 'Delete',
    186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
    219: '[', 220: '\\', 221: ']', 222: "'"
  };
  return m[vk] || '';
}

function sameAccel(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a || !b) return false;
  if (a.length === 1) a = a.toUpperCase();
  if (b.length === 1) b = b.toUpperCase();
  return a === b;
}

function dispatchPrefixAccel(accel) {
  if (!accel) return;
  for (const id in settings.hotkeys) {
    if (sameAccel(settings.hotkeys[id], accel)) { sendHotkey({ type: 'sound', id }); return; }
  }
  for (const cmd in settings.specialHotkeys) {
    if (sameAccel(settings.specialHotkeys[cmd], accel)) { sendHotkey({ type: 'cmd', cmd }); return; }
  }
  if (sameAccel(settings.pttKey, accel)) togglePtt();
}

function ensureKeyHookExe() {
  const exe = bundledHelper('sp_keyhook.exe');
  if (!exe) dbg('keyhook helper not found');
  return exe;
}

function stopKeyHook() {
  if (keyHook) {
    try { keyHook.kill(); } catch {}
  }
  keyHook = null;
  keyHookPrefix = '';
}

function startKeyHook() {
  if (!settings.prefixMode) { stopKeyHook(); return false; }
  const pk = settings.prefixKey || '\\';
  if (keyHook && keyHookPrefix === pk) return true;
  stopKeyHook();
  const exe = ensureKeyHookExe();
  if (!exe) return false;
  try {
    const proc = spawn(exe, [String(keyHookVk(pk)), String(KEYHOOK_HOLD_MS)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    keyHook = proc;
    keyHookPrefix = pk;
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line === 'HOOKOK') dbg('keyhook ready vk=' + keyHookVk(pk));
        else if (line === 'ARM') dbg('PREFIX hold');
        else if (line.indexOf('KEY ') === 0) {
          const vk = parseInt(line.slice(4), 10);
          const accel = vkToAccel(vk);
          dbg('PREFIXKEY ' + accel + ' vk=' + vk);
          dispatchPrefixAccel(accel);
        } else {
          dbg('keyhook ' + line);
          if (line.indexOf('HOOKFAIL') === 0) {
            // хук не поставился (антивирус/политики) — старый способ как запасной
            try {
              const ok = globalShortcut.register(pk, () => { dbg('PREFIX ' + pk); armPrefixKeys(); });
              if (ok) hotkeyMap.set(pk, { type: 'prefix' });
              dbg('reg prefix fallback ok=' + ok);
            } catch {}
            stopKeyHook();
          }
        }
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => { dbg('keyhook error ' + e.message); keyHook = null; });
    proc.on('exit', () => { if (keyHook === proc) keyHook = null; });
    return true;
  } catch (e) { dbg('keyhook spawn catch ' + e.message); keyHook = null; return false; }
}

function registerAll() {
  globalShortcut.unregisterAll();
  disarmPrefixKeys();
  hotkeyMap.clear();
  if (hotkeySuppressed) { stopKeyHook(); return; }
  if (settings.prefixMode) {
    const pk = settings.prefixKey || '\\';
    if (!startKeyHook()) {
      try {
        const ok = globalShortcut.register(pk, () => { dbg('PREFIX ' + pk); armPrefixKeys(); });
        if (ok) hotkeyMap.set(pk, { type: 'prefix' });
        dbg('reg prefix ' + pk + ' ok=' + ok);
      } catch {}
    }
  } else {
    stopKeyHook();
  }
  if (!settings.passHotkeys) {
    for (const id in settings.hotkeys) reg(settings.hotkeys[id], { type: 'sound', id });
  } else {
    // passHotkeys: одиночные клавиши не перехватываются, сочетания с модификаторами работают
    for (const id in settings.hotkeys) {
      const accel = settings.hotkeys[id];
      if (typeof accel === 'string' && accel.includes('+')) reg(accel, { type: 'sound', id });
    }
  }
  for (const cmd in settings.specialHotkeys) {
    const accel = settings.specialHotkeys[cmd];
    if (settings.passHotkeys && typeof accel === 'string' && !accel.includes('+') && !/^F\d{1,2}$/.test(accel)) continue;
    reg(accel, { type: 'cmd', cmd });
  }
  if (settings.indexHotkeys) {
    for (let i = 0; i <= 9; i++) {
      const key = i === 9 ? '0' : String(i + 1);
      reg('Ctrl+Alt+' + key, { type: 'index', index: i });
    }
  }
  reg(settings.pttKey, { type: 'ptt' });
}

function applyLoginItem() {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, path: process.execPath });
}

// ---------------- windows ----------------

// иконка: ищем в asar (icon.ico), рядом с asar (resources/build) и в dev-папке
function findIconPath() {
  const cands = [
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico')
  ];
  for (const c of cands) {
    try {
      const img = nativeImage.createFromPath(c);
      if (!img.isEmpty()) return c;
    } catch {}
  }
  return cands[1];
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1360, height: 840, minWidth: 1280, minHeight: 720,
    title: 'SoundPulse', icon: findIconPath(), backgroundColor: '#080b12', frame: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      // не тормозим таймеры/звук, когда окно свёрнуто или живёт в трее:
      // иначе перестаёт работать приглушение музыки при разговоре (дакинг)
      backgroundThrottling: false
    }
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), IS_SMOKE ? { hash: 'test' } : undefined);
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.webContents.on('render-process-gone', () => registerAll());
  // «В трее» = окно скрыто/свёрнуто. Сообщаем рендереру, чтобы он погасил
  // перерисовку (сияние, блюр, анимации). Звук, дакинг и хоткеи не трогаем:
  // Web Audio и глобальные сочетания продолжают работать.
  const sendTrayMode = (on) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    try { mainWin.webContents.send('win:tray-mode', !!on); } catch {}
  };
  mainWin.on('show', () => sendTrayMode(false));
  mainWin.on('hide', () => sendTrayMode(true));
  mainWin.on('minimize', () => sendTrayMode(true));
  mainWin.on('restore', () => sendTrayMode(false));
  mainWin.on('close', (e) => {
    if (quitting || IS_SMOKE) return;
    e.preventDefault();
    mainWin.webContents.send('win:close-requested');
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (process.platform !== 'darwin') {
      app.quit();
      setTimeout(() => { try { app.exit(0); } catch {} }, 1500);
    }
  });
  if (IS_SMOKE) {
    mainWin.webContents.on('did-finish-load', runSmoke);
    attachConsole(mainWin.webContents);
  }
}

function createTray() {
  let img;
  try {
    img = nativeImage.createFromPath(findIconPath());
    if (img.isEmpty()) img = nativeImage.createEmpty();
  } catch { img = nativeImage.createEmpty(); }
  tray = new Tray(img);
  tray.setToolTip('SoundPulse');
  const showWin = () => {
    if (!mainWin || mainWin.isDestroyed()) { createMainWindow(); return; }
    mainWin.show();
    mainWin.focus();
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать SoundPulse', click: showWin },
    { label: 'Скрыть в трей', click: () => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
    } },
    { type: 'separator' },
    { label: 'Выйти', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWin);
}

function attachConsole(wc) {
  wc.on('console-message', (e, level, message, line, source) => {
    console.log('RENDERER[' + level + '] ' + message + (line ? ' (' + source + ':' + line + ')' : ''));
  });
}

// ---------------- IPC ----------------

ipcMain.handle('store:get', () => ({ data: lib, settings }));
ipcMain.handle('settings:set', (e, patch) => {
  // бинды меняются только через hotkeys:set / special-hotkeys:set — иначе
  // отложенный saveConfig со старым/пустым hotkeyMap затирал все привязки
  if (patch && typeof patch === 'object') {
    delete patch.hotkeys;
    delete patch.specialHotkeys;
  }
  const prev = settings;
  settings = { ...settings, ...(patch || {}) };
  settings.pttKey = fixPttKey(settings.pttKey);
  saveJson(setFile(), settings);
  // перерегистрируем клавиши только если реально изменилось то, что на них влияет:
  // раньше любой ползунок дёргал registerAll и на миг отпускал все бинды
  const hotkeyTouched = ['pttKey', 'indexHotkeys', 'singleKeysGlobal', 'passHotkeys', 'prefixMode', 'prefixKey']
    .some((k) => prev[k] !== settings[k]);
  if (hotkeyTouched) registerAll();
  applyLoginItem();
  // окно настройки вида меняет настройки на лету: сообщаем всем окнам
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:changed', settings);
  }
  return { ok: true };
});

ipcMain.handle('library:save', (e, data) => {
  lib = { sounds: Array.isArray(data && data.sounds) ? data.sounds : (lib.sounds || []) };
  saveJson(libFile(), lib);
  return { ok: true };
});
ipcMain.handle('hotkeys:set', (e, map) => {
  const empty = !map || typeof map !== 'object' || Object.keys(map).length === 0;
  // защита от гонки при старте: рендерер мог ещё не загрузить бинды и
  // прислать пустую карту — не превращаем рабочие привязки в пустые
  if (empty && Date.now() - startedAt < 10000 && settings.hotkeys && Object.keys(settings.hotkeys).length) {
    dbg('hotkeys:set ignored empty-at-startup');
    return { ok: true, ignored: true };
  }
  settings.hotkeys = map || {};
  saveJson(setFile(), settings);
  dbg('hotkeys:set n=' + Object.keys(settings.hotkeys).length);
  registerAll();
  return { ok: true };
});
ipcMain.handle('special-hotkeys:set', (e, map) => {
  settings.specialHotkeys = map || {};
  saveJson(setFile(), settings);
  registerAll();
  return { ok: true };
});
ipcMain.handle('hotkeys:reset', (e) => {
  settings.hotkeys = {};
  settings.specialHotkeys = { stop: 'F8' };
  saveJson(setFile(), settings);
  registerAll();
  return { ok: true };
});
ipcMain.handle('hotkeys:suppress', (e, b) => {
  hotkeySuppressed = !!b;
  dbg('hotkeys:suppress ' + hotkeySuppressed);
  registerAll();
  return { ok: true };
});
ipcMain.handle('list:export', async (e, sounds) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Экспорт списка звуков', defaultPath: path.join(app.getPath('documents'), 'SoundPulse', 'soundlist.json'),
    filters: [{ name: 'Soundpad list', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' };
  try {
    const out = (Array.isArray(sounds) ? sounds : []).map(({ _handle, _startMs, _len, playing, missing, ...rest }) => rest);
    fs.writeFileSync(res.filePath, JSON.stringify(out, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('list:load', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Загрузить список звуков', properties: ['openFile'],
    filters: [{ name: 'Soundpad list', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, error: 'canceled' };
  try {
    const j = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    const arr = Array.isArray(j) ? j : (Array.isArray(j.sounds) ? j.sounds : []);
    return { ok: true, sounds: arr };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle('win:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle('win:hide', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.hide();
});
ipcMain.handle('win:quit', () => {
  quitting = true;
  mainWin?.close();
});

ipcMain.handle('fs:read', async (e, p) => {
  try { return { ok: true, data: await fs.promises.readFile(p) }; } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('fs:readHead', async (e, p, maxBytes) => {
  try {
    const max = Math.max(16384, Math.min(maxBytes || (8 * 1024 * 1024), 64 * 1024 * 1024));
    const fd = await fs.promises.open(p, 'r');
    try {
      const st = await fd.stat();
      const buf = Buffer.alloc(Math.min(st.size, max));
      await fd.read(buf, 0, buf.length, 0);
      return { ok: true, data: buf, full: buf.length === st.size };
    } finally { await fd.close(); }
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('fs:stat', async (e, p) => {
  try { const st = await fs.promises.stat(p); return { ok: true, exists: true, size: st.size }; } catch { return { ok: true, exists: false }; }
});

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm']);
ipcMain.handle('dialog:pickSounds', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Добавить звуки', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Аудио', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] }, { name: 'Все файлы', extensions: ['*'] }]
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => ({ name: path.basename(p), path: p }));
});
async function collectAudio(dir) {
  const out = [];
  const walk = async (d) => {
    let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const en of ents) {
      const full = path.join(d, en.name);
      if (en.isDirectory()) await walk(full);
      else if (AUDIO_EXT.has(path.extname(en.name).toLowerCase())) out.push({ name: en.name, path: full });
    }
  };
  await walk(dir);
  return out;
}
ipcMain.handle('dialog:pickFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, { title: 'Выбрать папку со звуками', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const root = res.filePaths[0];
  return { name: path.basename(root), root, files: await collectAudio(root) };
});
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
ipcMain.handle('dialog:pickImage', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Выбрать фоновое изображение', properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const file = res.filePaths[0];
  const MAX = 15 * 1024 * 1024;
  try {
    const st = await fs.promises.stat(file);
    if (st.size > MAX) return { ok: false, error: 'Файл больше 15 МБ' };
    const b = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase().replace('.', '');
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/png';
    return { ok: true, dataURL: 'data:' + mime + ';base64,' + b.toString('base64'), name: path.basename(file) };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('folder:scan', async (e, dir) => {
  try { return { ok: true, files: await collectAudio(dir) }; } catch (err) { return { ok: false, error: String(err) }; }
});

const CONTENT_DIRS = {
  recordings: () => path.join(app.getPath('documents'), 'SoundPulse', 'recordings'),
  downloads: () => path.join(app.getPath('documents'), 'SoundPulse', 'downloads')
};

// Перенос пользовательских файлов из Documents\PERDBOX в Documents\SoundPulse.
// Старую папку не удаляем — если что-то пойдёт не так, данные останутся на месте.
function migrateDocs() {
  try {
    const from = path.join(app.getPath('documents'), 'PERDBOX');
    const to = path.join(app.getPath('documents'), 'SoundPulse');
    if (!fs.existsSync(from)) return;
    if (!fs.existsSync(to)) {
      try { fs.renameSync(from, to); dbg('migrate: Documents перенесён'); return; } catch {}
    }
    fs.mkdirSync(to, { recursive: true });
    for (const name of ['soundlist.json', 'recordings', 'downloads']) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try { fs.renameSync(src, dst); }
      catch { try { fs.cpSync(src, dst, { recursive: true }); } catch {} }
    }
  } catch (e) { dbg('migrateDocs fail ' + e.message); }
}
ipcMain.handle('recording:save', async (e, buffer, name) => {
  const dir = CONTENT_DIRS.recordings(); fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, name + '.wav');
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, name + ' (' + n++ + ').wav');
  fs.writeFileSync(file, Buffer.from(buffer));
  return { ok: true, path: file };
});
ipcMain.handle('documents:open', async (e, which) => {
  const dir = CONTENT_DIRS[which] ? CONTENT_DIRS[which]() : null;
  if (!dir) return { ok: false, error: 'unknown' };
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true };
});
ipcMain.handle('shell:showItem', async (e, p) => { shell.showItemInFolder(p); });

const AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/aac', 'audio/webm', 'application/ogg']);
ipcMain.handle('web:download', async (e, url) => {
  const dir = CONTENT_DIRS.downloads(); fs.mkdirSync(dir, { recursive: true });
  try {
    const res = await new Promise((resolve) => {
      const req = net.request(url); const chunks = []; let type = '';
      req.on('response', (resp) => {
        type = String(resp.headers['content-type'] || '');
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ ok: true, buf: Buffer.concat(chunks), type }));
        } else resolve({ ok: false, error: 'HTTP ' + resp.statusCode });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.end();
    });
    if (!res.ok) return res;
    let pn; try { pn = new URL(url).pathname; } catch { pn = '/sound'; }
    let ext = path.extname(pn).toLowerCase();
    if (!AUDIO_EXT.has(ext)) {
      const base = res.type.split(';')[0].trim().toLowerCase();
      ext = AUDIO_MIME.has(base) ? ({ 'audio/mp4': '.m4a', 'audio/x-wav': '.wav', 'application/ogg': '.ogg', 'audio/mpeg': '.mp3' }[base] || '.' + base.replace('audio/', '').replace('x-', '')) : '.bin';
    }
    if (ext === '.bin') return { ok: false, error: 'По ссылке не аудиофайл' };
    let name = path.basename(pn); if (!name || name === '.') name = 'sound' + ext;
    const file = path.join(dir, name);
    fs.writeFileSync(file, res.buf);
    return { ok: true, path: file, name };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('app:openExternal', async (e, url) => { await shell.openExternal(url); });
ipcMain.handle('app:debug', (e, msg) => { try { dbg(String(msg).slice(0, 2000)); } catch {} });
ipcMain.handle('app:info', () => {
  let user = '';
  try {
    const u = os.userInfo();
    user = (u && (u.name || u.username)) || '';
  } catch {}
  return { version: app.getVersion(), userData: app.getPath('userData'), name: app.getName(), user };
});

// ---------------- app life ----------------

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' || perm === 'audioCapture'));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' || perm === 'audioCapture');
  migrateUserData();
  migrateDocs();
  loadStore();
  createMainWindow();
  createTray();
  // подчищаем осиротевший хук от прошлого запуска (если приложение упало)
  try { spawnSync('taskkill', ['/F', '/IM', 'sp_keyhook.exe'], { windowsHide: true }); } catch {}
  registerAll();
  setTimeout(() => ensurePttInjector(), 500); // прогреваем инжектор — первый нажим без задержки
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  disarmPrefixKeys();
  stopKeyHook();
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  disarmPrefixKeys();
  stopKeyHook();
  releasePttIfHeld();
  try { if (pttInj) pttInj.kill(); } catch {}
});

// ---------------- smoke ----------------

function runSmoke() {
  (async () => {
    try {
      const results = [];
      const run = async (code) => {
        try { results.push(String(await mainWin.webContents.executeJavaScript(code, true))); }
        catch (err) { results.push('ERR: ' + err.message); }
      };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // generate a test tone wav so playback path is fully exercised
      const tonePath = path.join(app.getPath('temp'), 'soundpulse_smoke_tone.wav');
      {
        const sr = 44100, n = sr * 2, buf = Buffer.alloc(44 + n * 2);
        buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
        buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
        buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
        buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
        for (let i = 0; i < n; i++) {
          const v = Math.sin(2 * Math.PI * 440 * (i / sr)) * 0.5;
          buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, 44 + i * 2);
        }
        fs.writeFileSync(tonePath, buf);
      }
      await wait(1500);
      await run(`JSON.stringify(window.__sp.initState())`);
      await run(`(async () => { const r = await window.__sp.addSoundFiles([{ name: 'smoke-ton', path: ${JSON.stringify(tonePath)} }]); return 'add=' + r; })()`);
      await run(`(async () => { const s = [...window.__sp.sounds.values()].find((x) => x.name === 'smoke-ton'); window.__sp.playSound(s.id); return 'play=' + s.name; })()`);
      await wait(800);
      await run(`(() => { const s = [...window.__sp.sounds.values()].find((x) => x.name === 'smoke-ton'); return 'state=' + ((s && s.playing) ? 1 : 0) + ' len=' + ((s && s._len) ? s._len.toFixed(1) : '?') + ' missing=' + ((s && s.missing) ? 1 : 0); })()`);
      await run(`(async () => { window.__sp.stopAll(); return 'stop'; })()`);
      await wait(300);
      await run(`(() => { const s = [...window.__sp.sounds.values()].find((x) => x.name === 'smoke-ton'); return 'stopped=' + ((s && s.playing) ? 1 : 0); })()`);
      await run(`(async () => { const x = [...window.__sp.sounds.values()].find((s) => s.name === 'smoke-ton'); if (x) window.__sp.removeSound(x.id); return 'clean'; })()`);
      await wait(300);
      await run(`(async () => { const r = await window.soundpad.settingsSet({ masterVolume: 0.25 }); return 'set=' + r.ok; })()`);
      await run(`(async () => { const b = document.getElementById('f-nothear'); b.click(); const off = window.__sp.sounds ? (window.__sp.sounds.size > 0) : false; return 'selfoff=' + (window.__sp.engine.selfOff ? 1 : 0); })()`);
      await run(`(async () => { document.getElementById('f-nothear').click(); return 'selfoff2=' + (window.__sp.engine.selfOff ? 1 : 0); })()`);
      await run(`JSON.stringify(window.__sp.initState())`);
      console.log('TEST_RESULTS: ' + JSON.stringify(results));
    } catch (err) {
      console.log('SMOKE_FATAL: ' + err.message);
    } finally {
      setTimeout(() => app.exit(0), 300);
    }
  })();
}

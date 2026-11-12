/* SoundPulse — steam-style soundpad renderer */

const api = window.soundpad;
const engine = new AudioEngine();
window.__tApp = performance.now(); // точка отсчёта: скрипт начал исполняться

const DEFAULT_CONFIG = {
  masterVolume: 0.25,
  monitor: true,
  monitorVol: 0.39,
  micEnabled: true,
  overlap: false,
  all: false,           // «Всем»: все звуки играют и в микрофон, и в динамики
  bass: 0,            // 0 off, 1 hard bass, 2 insane
  mute: false,
  selfOff: false,     // «Не слышу се»: kill speaker-канала
  outputDevice: '',
  speakerDevice: '',
  voiceMix: false,      // SoundPulse подмешивает мой голос в виртуальный микрофон
  voiceMicId: '',       // физический микрофон для голоса ('' = системный)
  voiceVolume: 100,     // громкость голоса, %
  voiceGate: 0,         // шумовые ворота 0..100 (0 = выкл)
  cableOff: false,      // не использовать VB-CABLE (для тех, у кого уже есть Sonar)
  cableRouteDone: false, // однократно перевели выход на кабель после установки — второй раз не лезем
  onboarded: false,     // мастер настройки пройден
  tourDone: false,      // обучение по использованию пройдено
  onboardingRev: 0,     // версия пройденного мастера: после обновления показываем заново
  categories: [{ id: 'default', name: 'Звуки' }],
  sounds: [],
  normalize: false,
  voiceActivation: false,
  ducking: true,      // приглушать музыку, когда говорю в микрофон
  duckLevel: 0.28,    // до какой громкости падает музыка при речи
  openAtLogin: false,
  padScale: 1,        // размер кнопок 0.7..1.4
  background: '',      // dataURL фона
  blur: true,          // размытие (стекло) интерфейса
  glassMode: 'blur', // материал интерфейса: обычное размытие (жидкое стекло удалено)
  glassModePrev: 'blur', // запасной режим (жидкое стекло удалено)
  indexHotkeys: true,
  passHotkeys: false,
  singleKeysGlobal: false, // одинарные буквы/цифры глобально (в фоне) вместо локальных
  prefixMode: true,       // префикс "\": удерживаем 0.10 с, затем клавиша
  prefixKey: '\\',        // символ префикса (можно поменять в настройках)
  uiSounds: true,         // звуки интерфейса (клики, хуверы, окна)
pttKey: 'T', // войс-чат: жми "\" — затем T (клавиша зажмётся/отпустится в игре)
  specialHotkeys: { stop: 'F8' },
  autoNext: true,       // после окончания песни играется следующая
  shuffle: false,       // автоследующая вразнобой
  loopOne: false,       // зациклить текущую
  // ---- внешний вид (окно «Настройка вида») ----
  accent: '#55a9ff',    // акцентный цвет
  radius: 22,           // скругление карточек
  cardScale: 1,         // размер карточек 0.8..1.3
  bgDim: 78,            // затемнение фоновой картинки, %
  aurora: true,         // подсветка фона
  anims: true,          // анимации/переходы
  animSpeed: 1,         // скорость анимаций 0.6..1.6
  tilt: true            // 3D-наклон карточек за мышкой
};

let config = { ...DEFAULT_CONFIG };
let hotkeyMap = {};        // soundId -> accelerator
let resumeState = null;    // {id, pos, ts} — запомненная пауза (трек + позиция)

// ---- звуки интерфейса: тихие тики/клики на все действия ----
// Звуки декодируются через Web Audio и обрезаются (убираем молчание в начале
// и длинный хвост в конце) — звук срабатывает мгновенно, без ожидания.
const UI_SOUNDS = {
  hover: '1.mp3', cardHover: '2.mp3', click: '3.mp3', cardClick: '4.mp3',
  toggle: '5.mp3', open: '6.mp3', close: '7.mp3', menu: '8.mp3',
  select: '9.mp3', drop: '10.mp3', success: '11.mp3', error: '12.mp3'
};
// макс. длительность по типу: тики короткие, окна/тосты чуть длиннее
const UI_MAX_DUR = {
  hover: 0.3, cardHover: 0.3, click: 0.3, cardClick: 0.3, toggle: 0.3,
  open: 0.8, close: 0.8, menu: 0.3, select: 0.3, drop: 1.2, success: 0.8, error: 0.8
};
let uiCtx = null;
let uiGain = null;
const uiBuffers = new Map();      // file -> { buf, start, end }
const uiAudioFallback = new Map(); // фолбэк на обычные <audio>
const uiLastAt = {};
let uiHoverEl = null;             // последний элемент, на котором играл «hover»

function ensureUiCtx() {
  if (uiCtx) return true;
  try {
    uiCtx = new AudioContext();
    uiGain = uiCtx.createGain();
    uiGain.gain.value = 0.12;
    uiGain.connect(uiCtx.destination);
    for (const file of [...new Set(Object.values(UI_SOUNDS))]) {
      fetch('ui/' + file).then((r) => r.arrayBuffer()).then((ab) =>
        uiCtx.decodeAudioData(ab).then((buf) => uiBuffers.set(file, uiTrim(buf, UI_MAX_DUR[fileToName(file)] || 0.4)))
      ).catch(() => {});
    }
    return true;
  } catch { return false; }
}
function fileToName(file) {
  for (const k in UI_SOUNDS) if (UI_SOUNDS[k] === file) return k;
  return null;
}
function uiTrim(buf, maxDur) {
  const data = buf.getChannelData(0);
  const n = data.length;
  let peak = 0;
  for (let i = 0; i < n; i += 1024) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
  const th = Math.max(peak * 0.02, 0.0005); // порог «слышимости»
  const rate = buf.sampleRate;
  let s = 0;
  for (let i = 0; i < n; i += 64) {
    if (Math.abs(data[i]) > th) { s = Math.max(0, i / rate - 0.02); break; }
  }
  const e = Math.min(buf.duration, s + maxDur);
  return { buf, start: s, end: e };
}
function uiSound(name) {
  if (!config.uiSounds) return;
  const now = performance.now();
  if (now - (uiLastAt[name] || 0) < 60) return; // анти-спам
  uiLastAt[name] = now;
  const file = UI_SOUNDS[name];
  if (!file) return;
  if (!ensureUiCtx()) return;
  const c = uiBuffers.get(file);
  if (c) {
    const src = uiCtx.createBufferSource();
    src.buffer = c.buf;
    src.connect(uiGain);
    src.start(0, c.start, c.end - c.start);
    return;
  }
  // буфер ещё декодируется — фолбэк на обычный элемент
  let a = uiAudioFallback.get(file);
  if (!a) { a = new Audio('ui/' + file); a.volume = 0.12; uiAudioFallback.set(file, a); }
  a.currentTime = 0;
  a.play().catch(() => {});
}
let searchQuery = '';
let currentCategory = null;   // null/'all' | 'none' | category id
let searchMatches = [];
let searchIndex = -1;
let history = [];             // {id, name, time}
let cableInputId = null;
let devices = [];
let micInputs = [];           // физические микрофоны (входы) — только для показа
let testRate = 1;
let stopMicProbe = null;
let holdTimer = null;           // таймер удержания карточки (режим выбора)
let heldId = null;
let pressX = 0, pressY = 0;     // точка нажатия (отмена холда при реальном движении)
let suppressClickUntil = 0;     // подавить клик после холда/двойного клика
let suppressCard = null;        // карточка, чей клик подавляется
let suppressAllUntil = 0;       // подавить ЛЮБОЙ клик после драга/движения с зажатой кнопкой
let cmdSoundId = null;          // последний звук, запущенный Random/перелистыванием
let lastClickAt = 0;
let lastClickNode = null;
let stoppedId = null;              // id последней остановленной карточки (визуальная метка)
let curPlayId = null;              // id последнего СТАРТОВАННОГО звука (для «Сейчас играет»)
let playTimer = null;            // отложенный клик-воспроизведение (ждём двойной клик)
const selection = new Set();     // выделенные карточки (галочки) для переноса группой

const sounds = new Map();     // id -> sound
const els = new Map();        // id -> DOM node

function padT() {
  return Math.max(0.7, Math.min(1.4, config.padScale || 1));
}

// ---------------- playback engine ----------------

function targetsFor(s) {
  // «Всем»: глобально играть в микрофон и динамики независимо от режима звука
  if (config.all) return config.micEnabled ? ['mic', 'spk'] : ['spk'];
  if (s.mode === 'speakers') return ['spk'];
  if (s.mode === 'both') return config.micEnabled ? ['mic', 'spk'] : ['spk'];
  // 'mic'
  if (!config.micEnabled && !config.monitor) return ['spk'];
  if (!config.micEnabled) return ['spk'];
  return ['mic']; // engine добавит "слышу себя" в колонки на monitorVol
}

function modeLabel(s) {
  return s.mode === 'mic' ? 'только в микрофон' : s.mode === 'speakers' ? 'только в динамики' : 'микрофон + динамики';
}

async function playSound(id, opts) {
  opts = opts || {};
  const s = sounds.get(id);
  if (!s) return;
  if (s.playing) { stopSound(s); return; }

  const targets = targetsFor(s);
  if (!targets.length) {
    toast('Включите «Микрофон» или «Слушать себя», чтобы играть звук', 'error');
    return;
  }

  // без «внахлёст» играет только один звук: гасим и звук, и его состояние в UI
  if (!config.overlap) {
    for (const x of config.sounds) {
      if (x.id !== s.id && x.playing) {
        x._token = (x._token || 0) + 1;
        x.playing = false;
        x._handle = null;
      }
    }
  }

  // токен: каждый запуск/стоп увеличивает его; устаревший await после него не стартует
  const myToken = (s._token = (s._token || 0) + 1);

// остановленная карточка (метка ■) запускается с места остановки, а не с начала
  let resumeOff = null;
  if (opts.offset == null && s.id === stoppedId && resumeState && resumeState.id === s.id) {
    resumeOff = resumeState.pos;
  }
  const rate = opts.rate || s.rate || 1;
  const startOffset = opts.offset != null ? opts.offset : (resumeOff != null ? resumeOff : (s.offset || 0));
  setNowPlaying(s); // надпись «Сейчас играет» — сразу по клику, не дожидаясь загрузки буфера
const handle = await engine.play(s, targets, {
    rate,
    offset: startOffset,
    loop: !!(opts.loop || s.loop || config.loopOne),
    fadeIn: +s.fadeIn || 0,
    fadeOut: +s.fadeOut || 0,
    overlap: config.overlap,
    monitor: config.monitor && s.mode === 'mic',
    onend: () => {
      if (s._handle === handle) {
        finishSound(s);
        maybeAutoNext(s);
      }
    }
  });
  try { window.soundpad.debug('play: id=' + s.id + ' ok=' + !!handle + ' name=[' + (s.name || '') + ']'); } catch {}
  if (handle && handle.aborted) return; // запуск отменён более новым кликом — не ошибка
  if (s._token !== myToken) {
    // пока грузился буфер — пришёл новый запуск/стоп: если группа уже создалась,
    // гасим её, иначе устаревший звук остаётся играть (баг «до 5 песен сразу»)
    if (handle) engine.stop(s.id);
    return;
  }
  if (!handle) {
    s.missing = true;
    toast('Не удалось загрузить звук: ' + s.name, 'error');
    refreshPlaybackUI();
    return;
  }
  s.missing = false;
  s._handle = handle;
  s.playing = true;
  curPlayId = s.id; // «Сейчас играет» показывает последний запущенный
  stoppedId = null; // поехала музыка — метка «остановлено» снимается
  s._heldLoop = !!(opts.loop || s.loop || config.loopOne);
  s.plays = (s.plays || 0) + 1;
  s._startMs = performance.now();
  s._startOffset = startOffset;
  s._rate = rate;
  if (resumeState) { resumeState = null; saveConfig(); }
  const buf = await engine.getBuffer(s.path).catch(() => null);
  s._len = (buf ? buf.duration : 0) / rate;
  pushHistory(s);
  setNowPlaying(s);
  refreshPlaybackUI();
}

function finishSound(s, silent) {
  if (!s.playing) { s._handle = null; return; }
  s.playing = false;
  s._handle = null;
  if (!silent) refreshPlaybackUI();
}

function stopSound(s, noMark) {
  s._token = (s._token || 0) + 1; // прервать устаревший запуск
  s._heldLoop = false;
  if (!noMark) {
    stoppedId = s.id; // метка «остановлено» на карточке
    // если это была последняя играющая — запоминаем позицию: следующий
    // «Плей» продолжит с того места (перемотка тоже учитывается)
    if (!config.sounds.some((x) => x !== s && x.playing)) {
      let pos = curPosOf(s);
      if (s._len > 0) pos = Math.min(pos, Math.max(0, s._len - 0.02));
      resumeState = { id: s.id, pos, ts: Date.now() };
    }
  }
  finishSound(s);
  engine.stop(s.id); // гасим ВСЕ живые группы этого звука
}

function stopAll() {
  const lastPlayed = [...config.sounds].reverse().find((x) => x.playing);
  if (lastPlayed) {
    stoppedId = lastPlayed.id;
    let pos = curPosOf(lastPlayed);
    if (lastPlayed._len > 0) pos = Math.min(pos, Math.max(0, lastPlayed._len - 0.02));
    resumeState = { id: lastPlayed.id, pos, ts: Date.now() };
  }
  for (const s of config.sounds) {
    s._token = (s._token || 0) + 1;
    if (s.playing) finishSound(s, true);
  }
  engine.stopAll(); // глушит ВСЕ живые группы без исключения
  refreshPlaybackUI();
}

function setNowPlaying(s) {
  const el = document.getElementById('current');
  if (!el) return;
  let txt = s ? (s.name || (s.path ? s.path.split(/[\\/]/).pop() : '—')) : '—';
  if (txt.length > 72) txt = txt.slice(0, 71) + '…'; // предел: интерфейс не разъезжается
  if (el.textContent === txt) return;
  try { window.soundpad.debug('now: [' + txt + '] id=' + (s ? s.id : 'null')); } catch {}
  el.classList.remove('cur-fade');
  void el.offsetWidth;
  el.textContent = txt;
  el.classList.add('cur-fade');
}

// ---------------- history ----------------

function pushHistory(s) {
  history.unshift({ id: s.id, name: s.name, time: new Date() });
  if (history.length > 50) history.length = 50;
}

// ---------------- rendering ----------------

function soundsInSet() {
  if (!currentCategory || currentCategory === 'all') return config.sounds;
  if (currentCategory === 'none') return config.sounds.filter((s) => !s.category);
  return config.sounds.filter((s) => s.category === currentCategory);
}

function visibleSounds() {
  let list = soundsInSet();
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter((s) => s.name.toLowerCase().includes(q));
  }
  return list;
}

// лёгкое обновление после старта/стопа песни: НЕ пересобираем всю сетку
// (раньше render() заново создавал 40+ карточек и обложки — отсюда фризы
// на 1-2 секунды при каждом включении/переключении трека)
function refreshPlaybackUI() {
  for (const [id, el] of els) {
    const s = sounds.get(id);
    if (!s) continue;
    const wasPlaying = el.classList.contains('playing');
    el.classList.toggle('playing', !!s.playing);
    // старт трека: короткая вспышка рамки обложки (один элемент, один раз)
    if (s.playing && !wasPlaying) {
      el.classList.remove('burst');
      void el.offsetWidth;
      el.classList.add('burst');
      clearTimeout(el._burstTimer);
      el._burstTimer = setTimeout(() => el.classList.remove('burst'), 720);
    }
    el.classList.toggle('stopped', s.id === stoppedId);
    el.classList.toggle('missing', !!s.missing);
    // метка «остановлено» (■) живёт отдельным элементом — синхронизируем
    const badge = el.querySelector('.stop-badge');
    if (s.id === stoppedId && !badge) {
      const sb = document.createElement('span');
      sb.className = 'stop-badge';
      sb.textContent = '\u25A0';
      sb.title = 'Остановлено — нажми «Плей», чтобы продолжить';
      el.appendChild(sb);
    } else if (s.id !== stoppedId && badge) {
      badge.remove();
    }
  }
  renderNow();
  renderFooter();
  renderBassButton();
  renderFooterButtons();
}

function render() {
  renderSets();
  renderGrid();
  renderNow();
  renderFooter();
  renderBassButton();
  renderFooterButtons();
}

function renderSets() {
  const wrap = document.getElementById('sets');
  wrap.innerHTML = '';
  let si = 0;
  const add = (el) => { el.style.setProperty('--si', String(si++)); wrap.appendChild(el); };
  add(setRow('all', 'Все звуки', config.sounds.length, null));
  for (const c of config.categories) {
    const count = config.sounds.filter((s) => s.category === c.id).length;
    add(setRow(c.id, c.name, count, c));
  }
}

function setRow(id, name, count, cat) {
  const el = document.createElement('button');
  el.className = 'set' + (currentCategory === id ? ' active' : '');
  el.dataset.cat = id;
  const nm = document.createElement('span');
  nm.className = 'set-name';
  nm.textContent = name;
  const cnt = document.createElement('span');
  cnt.className = 'count';
  cnt.textContent = count;
  el.appendChild(nm);
  el.appendChild(cnt);
  if (cat) {
    const r = document.createElement('button');
    r.className = 'set-ren';
    r.title = 'Переименовать';
    r.textContent = '\u270e';
    const d = document.createElement('button');
    d.className = 'set-del';
    d.title = 'Удалить набор';
    d.textContent = '\u2715';
    el.appendChild(r);
    el.appendChild(d);
    r.addEventListener('click', (e) => { e.stopPropagation(); renameCategory(cat.id); });
    d.addEventListener('click', (e) => { e.stopPropagation(); deleteCategory(cat.id); });
  }
  el.addEventListener('click', () => {
    currentCategory = id;
    searchQuery = '';
    document.getElementById('search').value = '';
    searchMatches = [];
    searchIndex = -1;
    gridAnimSeq++;
    render();
  });
  return el;
}

let lastGridKey = null;
let gridAnimSeq = 0;        // принудительная анимация (клик по набору)
let lastGridAnimSeq = 0;
function renderGrid() {
  if (selection.size) selection.clear();
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const t = padT();
  grid.style.gap = Math.round(12 * t) + 'px';
  // сверху запас под фиксированный бар «Сейчас играет»: первый ряд стоит под
  // ним, а при прокрутке карточки проходят ПОД бар и он их размывает
  const side = Math.round(20 * t);
  grid.style.padding = (side + 55) + 'px ' + side + 'px ' + (side + 30) + 'px';
  const list = visibleSounds();
  const key = currentCategory + '|' + searchQuery;
  const animate = lastGridKey !== key || gridAnimSeq !== lastGridAnimSeq;
  const setChanged = gridAnimSeq !== lastGridAnimSeq;
  lastGridKey = key;
  lastGridAnimSeq = gridAnimSeq;
  grid.classList.toggle('no-anim', !animate);
  // смена набора: лёгкий «вдох» всей сетки поверх каскада карточек.
  // При поиске (ключ меняется на каждую букву) сетку не дёргаем.
  if (setChanged) {
    grid.classList.remove('swap-in');
    void grid.offsetWidth;
    grid.classList.add('swap-in');
    clearTimeout(grid._swapTimer);
    grid._swapTimer = setTimeout(() => grid.classList.remove('swap-in'), 520);
  }
  let vis = 0;
  for (const s of list) {
    const el = soundNode(s);
    grid.appendChild(el);
    if (animate) {
      el.style.animationDelay = Math.min(vis, 24) * 25 + 'ms';
      vis++;
    }
  }
  if (!list.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'width:100%;text-align:center;color:#7f8ba2;margin-top:60px;line-height:1.7';
    empty.innerHTML = searchQuery
      ? 'Ничего не найдено по запросу «' + escapeHtml(searchQuery) + '»'
      : 'Звуков пока нет.<br>Нажмите «＋ Добавить звуки», перетащите файлы сюда<br>или импортируйте через «Импорт»';
    grid.appendChild(empty);
  }
  // подставляем/догружаем обложки для видимых карточек (после сборки списка)
  hydrateCovers();
}

function soundNode(s) {
  const el = document.createElement('button');
  el.className = 'sound' + (s.playing ? ' playing' : '') + (s.missing ? ' missing' : '') + (s.id === stoppedId ? ' stopped' : '');
  el.dataset.id = s.id;
  el.draggable = true;
  el.title = s.name + '\n' + s.path;
  const t = padT();
  const cs = Math.max(0.8, Math.min(1.3, config.cardScale || 1));
  el.style.width = Math.round(132 * t * cs) + 'px';

  // обложка: сначала сгенерированный градиент + буква, потом подставится встроенный арт
  const cover = document.createElement('div');
  cover.className = 'sound-cover pending';
  cover.style.background = gradientFor(s.name);
  // цвет-акцент карточки: пока нет обложки — берём из её градиента,
  // когда обложка загрузится, setCoverGlow заменит на доминирующий цвет арта
  el.style.setProperty('--glow', coverColorFor(s.name));
  const letter = document.createElement('span');
  letter.className = 'sound-letter';
  letter.textContent = (s.name || '\u266A').trim().charAt(0).toUpperCase();
  cover.appendChild(letter);

  if (s.hotkey) {
    const b = document.createElement('span');
    b.className = 'badge key';
    b.textContent = prettyHotkey(s.hotkey);
    b.style.cssText = 'position:absolute;top:6px;left:8px;font-size:9px';
    el.appendChild(b);
  }
  if (typeof s.volume === 'number' && s.volume < 0.999) {
    const v = document.createElement('span');
    v.className = 'badge vol';
    v.textContent = Math.round(s.volume * 100) + '%';
    v.style.cssText = 'position:absolute;top:6px;right:8px;font-size:9px';
    el.appendChild(v);
  }

  const name = document.createElement('div');
  name.className = 'sound-name';
  name.textContent = s.name;

  const prog = document.createElement('div');
  prog.className = 'progress';
  const bar = document.createElement('i');
  prog.appendChild(bar);

const waves = document.createElement('div');
  waves.className = 'waves';
  for (let i = 0; i < 4; i++) waves.appendChild(document.createElement('i'));

  if (s.id === stoppedId) {
    const sb = document.createElement('span');
    sb.className = 'stop-badge';
    sb.textContent = '\u25A0';
    sb.title = 'Остановлено — нажми «Плей», чтобы продолжить';
    el.appendChild(sb);
  }

  el.appendChild(cover);
  cover.appendChild(prog);
  cover.appendChild(waves);
  el.appendChild(name);
  // наведение = головной старт: начинаем декодировать заранее, клик потом играет сразу
  el.addEventListener('mouseenter', () => {
    if (!s._prefetched) { s._prefetched = true; engine.getBuffer(s.path).catch(() => {}); }
  });
  els.set(s.id, el);
  // Обложки грузим лениво (только видимые карточки), но готовый арт из кэша
  // подставляем СРАЗУ. Иначе каждый render() (клик/перелистывание/авто-следующая)
  // пересоздавал карточки, и они мигали дефолтными градиентами.
  const cachedCover = coverCache.get(s.path);
  if (cachedCover !== undefined && cachedCover !== null) {
    applyCover(cover, cachedCover);
    if (cachedCover) setCoverGlow(cover, cachedCover, s.path);
  }
  return el;
}

// ---------------- обложки ----------------

const COVER_GRADIENTS = [
  'linear-gradient(145deg,#3a6ea5,#1d2f4e)',
  'linear-gradient(145deg,#7b3fa0,#2a1648)',
  'linear-gradient(145deg,#2f8f74,#103a30)',
  'linear-gradient(145deg,#b0632f,#4a2310)',
  'linear-gradient(145deg,#8f3f5e,#3a1224)',
  'linear-gradient(145deg,#3f7f8f,#122f38)',
  'linear-gradient(145deg,#5f5fb0,#23234f)',
  'linear-gradient(145deg,#a06b2f,#3d2610)'
];
const COVER_COLORS = ['#3a6ea5', '#7b3fa0', '#2f8f74', '#b0632f', '#8f3f5e', '#3f7f8f', '#5f5fb0', '#a06b2f'];
function gradientFor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[h % COVER_GRADIENTS.length];
}
function coverColorFor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}

const coverCache = new Map(); // path -> dataURL | '' (встроенного арта нет) | null (читается)
let coverRun = 0;
const coverQueue = [];

// Обложка почти всегда лежит в начале файла (ID3v2 / FLAC PICTURE).
// Читаем ТОЛЬКО голову (макс 4МБ) — в 99% случаев хватает, и интерфейс
// не лагает при массовом добавлении песен (не читаем весь файл на каждую).
// null = обложка ещё читается, '' = встроенного арта нет, строка = готовый dataURL
function loadCover(s) {
  if (!s || !s.path) return;
  const art = coverCache.get(s.path);
  if (art !== undefined && art !== null) { paintCover(s); return; }
  if (art === null) return; // уже читается — по завершении перекрасим все карточки
  coverCache.set(s.path, null);
  coverQueue.push(s.path);
  pumpCovers();
}

// перекрасить одну карточку по кэшу (элемент мог быть пересоздан render-ом)
function paintCover(s) {
  const card = els.get(s.id);
  if (!card) return;
  const coverEl = card.querySelector('.sound-cover');
  if (!coverEl) return;
  const art = coverCache.get(s.path);
  if (art === undefined || art === null) return;
  applyCover(coverEl, art);
  if (art) setCoverGlow(coverEl, art, s.path);
}

function pumpCovers() {
  while (coverRun < 4 && coverQueue.length) {
    const path = coverQueue.shift();
    coverRun++;
    (async () => {
      let art = '';
      try {
        const res = await window.soundpad.fsReadHead(path, 4 * 1024 * 1024);
        if (res && res.ok && res.data && res.data.byteLength) art = extractArt(new Uint8Array(res.data));
      } catch {}
      coverCache.set(path, art);
      // применяем ко ВСЕМ живым карточкам с этим путём: пока читалось, render
      // мог заменить элементы, и старые ссылки уже не в DOM
      for (const [id, card] of els) {
        const snd = sounds.get(id);
        if (!snd || snd.path !== path) continue;
        const coverEl = card.querySelector('.sound-cover');
        if (!coverEl) continue;
        applyCover(coverEl, art);
        if (art) setCoverGlow(coverEl, art, path);
      }
      coverRun--;
      pumpCovers();
    })();
  }
}

// добираем обложки для карточек в зоне видимости (+ запас), без IO:
// детерминированно и переживает любые перерисовки списка
let coverHydrateTimer = null;
function hydrateCovers() {
  coverHydrateTimer = null;
  const card = document.getElementById('grid');
  if (!card) return;
  const gr = card.getBoundingClientRect();
  for (const el of card.querySelectorAll('.sound')) {
    const coverEl = el.querySelector('.sound-cover');
    if (!coverEl || !coverEl.classList.contains('pending')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < gr.top - 400 || r.top > gr.bottom + 400) continue;
    const s = sounds.get(el.dataset.id);
    if (s) loadCover(s);
  }
}
function scheduleCoverHydrate() {
  if (coverHydrateTimer) return;
  coverHydrateTimer = setTimeout(hydrateCovers, 40);
}

function applyCover(coverEl, art) {
  if (!coverEl) return;
  coverEl.classList.remove('pending');
  if (art) {
    coverEl.style.backgroundImage = 'url(' + art + ')';
    coverEl.style.backgroundSize = 'cover';
    coverEl.style.backgroundPosition = 'center';
    coverEl.classList.add('has-art');
  } else {
    coverEl.style.backgroundImage = '';
    coverEl.classList.remove('has-art');
  }
}

const glowCache = new Map(); // path -> 'rgb(r,g,b)' | null (грузится) | '' (цвет не определён)

function dominantColor(art) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = 24; cv.height = 24;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, 24, 24);
          const d = ctx.getImageData(0, 0, 24, 24).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 50) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
          if (!n) return resolve('');
          const R = Math.max(0, Math.min(255, Math.round(r / n)));
          const G = Math.max(0, Math.min(255, Math.round(g / n)));
          const B = Math.max(0, Math.min(255, Math.round(b / n)));
          resolve('rgb(' + R + ',' + G + ',' + B + ')');
        } catch { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = art;
    } catch { resolve(''); }
  });
}

function setCoverGlow(coverEl, art, path) {
  const target = coverEl.closest('.sound') || coverEl;
  if (glowCache.has(path)) {
    const c = glowCache.get(path);
    if (c) target.style.setProperty('--glow', c);
    return;
  }
  glowCache.set(path, null);
  dominantColor(art).then((c) => {
    glowCache.set(path, c || '');
    if (c) target.style.setProperty('--glow', c);
  }).catch(() => { glowCache.set(path, ''); });
}

function bytesToDataURL(mime, u8, start, len) {
  let bin = '';
  const CH = 0x8000;
  for (let i = start; i < start + len; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, start + len)));
  }
  return 'data:' + mime + ';base64,' + btoa(bin);
}

// вытаскивает встроенную обложку из MP3 (ID3v2 APIC) или FLAC (PICTURE)
function extractArt(u8) {
  const L = u8.length;
  if (L > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    const ver = u8[3];
    const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    let off = 10;
    const end = Math.min(10 + size, L);
    while (off + 10 <= end) {
      const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
      const fsize = ver >= 4
        ? ((u8[off + 4] & 0x7f) << 21) | ((u8[off + 5] & 0x7f) << 14) | ((u8[off + 6] & 0x7f) << 7) | (u8[off + 7] & 0x7f)
        : (u8[off + 4] << 24) | (u8[off + 5] << 16) | (u8[off + 6] << 8) | u8[off + 7];
      const flags = (u8[off + 8] << 8) | u8[off + 9];
      off += 10;
      if (flags & 0x40) off += 4; // ID3v2.4 additional size
      if (id === 'APIC' && fsize > 0 && off + fsize <= end) {
        const enc = u8[off];
        let p = off + 1;
        let mime = '';
        while (p < end && u8[p] !== 0) mime += String.fromCharCode(u8[p++]);
        p++; // null
        p++; // type byte
        if (enc === 1 || enc === 2) {
          if (u8[p] === 0 && u8[p + 1] === 0) p += 2;
          else while (p + 1 < end && !(u8[p] === 0 && u8[p + 1] === 0)) p += 2;
        } else {
          while (p < end && u8[p] !== 0) p++;
        }
        p++;
        const dataLen = off + fsize - (p - off);
        if (dataLen > 0 && dataLen < 4 * 1024 * 1024) return bytesToDataURL(mime || 'image/jpeg', u8, p, dataLen);
        break;
      }
      off += fsize;
    }
  }
  if (L > 4 && u8[0] === 0x66 && u8[1] === 0x4c && u8[2] === 0x61 && u8[3] === 0x43) {
    let off = 4;
    let last = false;
    while (!last && off + 4 <= L) {
      last = (u8[off] & 0x80) !== 0;
      const type = u8[off] & 0x7f;
      const len = (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
      off += 4;
      if (type === 6 && len > 8 && off + len <= L) {
        const u32 = (o) => (u8[o] * 0x1000000) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];
        const mimeLen = u32(off + 4);
        let p = off + 8;
        if (mimeLen > 0 && p + mimeLen <= L) {
          let mime = '';
          for (let i = 0; i < mimeLen; i++) mime += String.fromCharCode(u8[p + i]);
          p += mimeLen;
          const descLen = u32(p); p += 4 + descLen;
          p += 16; // width, height, depth, colors
          const dataLen = u32(p); p += 4;
          if (dataLen > 0 && dataLen < 4 * 1024 * 1024 && p + dataLen <= off + len) return bytesToDataURL(mime || 'image/jpeg', u8, p, dataLen);
        }
        break;
      }
      off += len;
    }
  }
  return '';
}

function renderNow() {
  const playing = config.sounds.filter((s) => s.playing);
  const nb = document.querySelector('.nowbar');
  if (nb) nb.classList.toggle('playing', playing.length > 0);
  // фон «оживает», пока что-то играет (чисто CSS, без нагрузки на JS)
  document.body.classList.toggle('is-playing', playing.length > 0);
  if (playing.length) {
    // последний СТАРТОВАННЫЙ звук (не по порядку в списке — при overlap важно)
    const cur = playing.find((x) => x.id === curPlayId) || playing[playing.length - 1];
    setNowPlaying(cur);
  }
  updatePlaybar();
}

function updatePlaybar() {
  const pbtn = document.getElementById('btn-playpause');
  const playing = config.sounds.some((s) => s.playing);
  if (pbtn) pbtn.classList.toggle('is-playing', playing);
  const loopB = document.getElementById('btn-loop');
  if (loopB) loopB.classList.toggle('active', !!config.loopOne);
  const shufB = document.getElementById('btn-shuffle');
  if (shufB) shufB.classList.toggle('active', !!config.shuffle);
  const autoB = document.getElementById('btn-auto');
  if (autoB) autoB.classList.toggle('active', !!config.autoNext);
}

function paintRange(el) {
  if (!el) return;
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const p = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', Math.max(0, Math.min(100, p)).toFixed(2) + '%');
}

function renderFooter() {
  initEq();
  const el = document.getElementById('foot-count');
  const total = config.sounds.reduce((sum, s) => sum + (s.plays || 0), 0);
  el.textContent = 'Звуков: ' + config.sounds.length + ' · Проиграно: ' + total;
  const playingNow = config.sounds.some((s) => s.playing);
  document.body.classList.toggle('no-play', !playingNow);
  if (playingNow) { startEq(); startTick(); } else { stopEq(); stopTick(); }
}

// ---- эквалайзер в футере: реальные уровни из analyser'а (реагирует на звук) ----
const eqBars = [];
let eqRunning = false;
const eqData = new Uint8Array(128);
function initEq() {
  const host = document.getElementById('eq-bars');
  if (!host || eqBars.length) return;
  for (let i = 0; i < 3; i++) {
    const b = document.createElement('i');
    // полоска-капсула: высота 6..18px меняется напрямую, чтобы скругление
    // не сплющивалось (scaleY делал торец овальным)
    b.style.cssText = 'display:inline-block;width:4px;height:6px;background:#3ddc84;border-radius:9px;margin:0 3px 0 0;';
    host.appendChild(b);
    eqBars.push(b);
  }
}
function eqTick() {
  const chain = engine && engine.spkCtx;
  if (!chain || !chain.analyser) { for (const b of eqBars) b.style.height = '6px'; return; }
  const an = chain.analyser;
  an.getByteFrequencyData(eqData);
  const bands = [
    avgOf(eqData, 0, 5),
    avgOf(eqData, 6, 16),
    avgOf(eqData, 17, 31)
  ];
  for (let i = 0; i < eqBars.length; i++) {
    const h = Math.max(6, Math.min(18, Math.round(bands[i] / 255 * 18)));
    eqBars[i].style.height = h + 'px';
  }
}
function avgOf(arr, a, b) {
  let s = 0; for (let i = a; i <= b; i++) s += arr[i];
  return s / (b - a + 1);
}
function startEq() { eqRunning = true; }
function stopEq() { eqRunning = false; for (const b of eqBars) b.style.height = '6px'; }

function renderBassButton() {
  const b = document.getElementById('f-bass');
  // подпись меняется только внутри .lbl — иконку не трогаем
  const labels = ['Пердящие', 'БАСЫ', 'ЖЕСТЬ', 'КНОПОЧНЫЙ', '425 БАЗА'];
  const lbl = b.querySelector('.lbl');
  if (lbl) lbl.textContent = labels[config.bass] || labels[0];
  b.classList.toggle('active', config.bass !== 0);
  b.classList.toggle('bass-hard', config.bass === 2);
  b.classList.toggle('bass-phone', config.bass === 3);
  b.classList.toggle('bass-radio', config.bass === 4);
  b.title = 'Звук: ' + (labels[config.bass] || labels[0]) + ' — клик меняет эффект';
}

function renderFooterButtons() {
  document.getElementById('f-mic').classList.toggle('active', !!config.micEnabled);
  document.getElementById('f-overlap').classList.toggle('active', !!config.overlap);
  const nh = document.getElementById('f-nothear');
  nh.classList.toggle('active', !!config.selfOff);
  nh.style.borderColor = config.selfOff ? 'rgba(255,90,105,.6)' : '';
  nh.style.color = config.selfOff ? '#ff8b94' : '';
  document.getElementById('f-mute').classList.toggle('active', !!config.mute);
  const all = document.getElementById('f-all');
  all.classList.toggle('active', !!config.all);
  all.classList.toggle('muted', !config.all);
}

// progress tick — крутится ТОЛЬКО пока что-то играет,
// в простое rAF не гоняем (иначе backdrop-filter пересчитывается каждый кадр и грузит комп)
let tickOn = false;
let lastTickUi = 0;
function tick(ts) {
  const playing = config.sounds.filter((s) => s.playing);
  // «Сейчас играет» каждую долю сверяем с тем, что реально играет
  const cur = playing.find((x) => x.id === curPlayId) || playing[playing.length - 1];
  if (cur) setNowPlaying(cur);
  // DOM/analyser обновляем ~15 раз в секунду, а не 60: прогресс и эквалайзер
  // не требуют каждого кадра, зато перестают грузить композитор вхолостую
  if (!ts || ts - lastTickUi >= 66) {
    lastTickUi = ts || 0;
    if (eqRunning) eqTick();
    let pct = -1;
    if (cur) {
      const pos = curPosOf(cur);
      pct = cur._len > 0 ? Math.min(100, (pos / cur._len) * 100) : 0;
      if (!seekDragging) {
        const seek = document.getElementById('seek-bar');
        if (seek) {
          seek.value = Math.round((pos / Math.max(cur._len, 0.0001)) * 1000);
          paintRange(seek);
          const tCur = document.getElementById('seek-cur');
          const tAll = document.getElementById('seek-all');
          if (tCur) tCur.textContent = fmtTime(pos);
          if (tAll) tAll.textContent = fmtTime(cur._len);
        }
      }
    }
    for (const s of playing) {
      const el = els.get(s.id);
      if (!el) continue;
      const pos = curPosOf(s);
      const sp = s._len > 0 ? Math.min(100, (pos / s._len) * 100) : 0;
      const bar = el.querySelector('.progress i');
      // scaleX вместо width: не вызывает пересчёт layout на каждом кадре
      if (bar) bar.style.transform = 'scaleX(' + ((s.id === cur?.id && pct >= 0 ? pct : sp) / 100).toFixed(4) + ')';
    }
  }
  if (tickOn) requestAnimationFrame(tick);
}
function startTick() { if (trayMode) return; if (!tickOn) { tickOn = true; lastTickUi = 0; requestAnimationFrame(tick); } }
function stopTick() { tickOn = false; };

// ---- режим «в трее»: окно спрятано, картинку никто не видит ----
// Гасим rAF/эквалайзер и вешаем на body класс tray-mode — он убирает
// сияние, backdrop-filter и бесконечные анимации (именно они грузят
// renderer и gpu-process). Звук, дакинг и глобальные хоткеи живут
// отдельно и продолжают работать.
let trayMode = false;
function setTrayMode(on) {
  trayMode = !!on;
  document.body.classList.toggle('tray-mode', trayMode);
  if (trayMode) {
    stopTick();
    stopEq();
    return;
  }
  // окно вернулось: сияние перерисовываем — пока оно было display:none,
  // размеры полотна были нулевые
  try { renderAurora(); } catch {}
  if (config.sounds.some((s) => s.playing)) { startEq(); startTick(); }
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ---------------- devices ----------------

// «Виртуальный» микрофон — это устройство-эхо: в него можно ПИСАТЬ звук,
// а голосовой чат читает его как микрофон. Физический микрофон так не умеет:
// Windows не даёт приложениям подмешивать звук во входной поток.
function isVirtualMicLabel(label) {
  return /cable|sonar|virtual|vb-?audio|voicemeeter|стерео\s*микшер|stereo\s*mix|what u hear/i.test(label || '');
}

// Маршрут для КОНКРЕТНО выбранного устройства вывода.
// Это ключ к персонализации: если человек выбрал CABLE Input — везде должен быть
// CABLE Output, а не «первый подходящий» Sonar. И наоборот.
function virtualRouteFor(outId) {
  const outs = devices || [];
  const ins = micInputs || [];
  const out = outs.find((d) => d.id === outId) || null;
  if (!out) return null;
  const lbl = out.label || '';
  if (!isVirtualMicLabel(lbl)) return null;

  if (/cable/i.test(lbl)) {
    const inDev = ins.find((d) => /cable/i.test(d.label) && /output/i.test(d.label))
      || ins.find((d) => /cable/i.test(d.label)) || null;
    return {
      mode: 'cable',
      outId: out.id,
      outLabel: out.label,
      inId: inDev ? inDev.id : null,
      inLabel: inDev ? inDev.label : 'CABLE Output',
      label: inDev ? inDev.label : 'CABLE Output',
      discord: inDev ? inDev.label : 'CABLE Output'
    };
  }

  if (/sonar/i.test(lbl)) {
    const inDev = ins.find((d) => /sonar/i.test(d.label) && /microphone|микрофон/i.test(d.label))
      || ins.find((d) => /sonar/i.test(d.label) && /stream/i.test(d.label))
      || ins.find((d) => /sonar/i.test(d.label)) || null;
    return {
      mode: 'sonar',
      outId: out.id,
      outLabel: out.label,
      inId: inDev ? inDev.id : null,
      inLabel: inDev ? inDev.label : out.label,
      label: inDev ? inDev.label : out.label,
      discord: inDev ? inDev.label : out.label
    };
  }

  if (/voicemeeter/i.test(lbl)) {
    const inDev = ins.find((d) => /voicemeeter/i.test(d.label)) || null;
    return {
      mode: 'voicemeeter',
      outId: out.id,
      outLabel: out.label,
      inId: inDev ? inDev.id : null,
      inLabel: inDev ? inDev.label : out.label,
      label: inDev ? inDev.label : out.label,
      discord: inDev ? inDev.label : out.label
    };
  }

  const inDev = ins.find((d) => d.label === lbl) || null;
  return {
    mode: 'other',
    outId: out.id,
    outLabel: out.label,
    inId: inDev ? inDev.id : null,
    inLabel: inDev ? inDev.label : out.label,
    label: inDev ? inDev.label : out.label,
    discord: inDev ? inDev.label : out.label
  };
}

function detectMicRoute() {
  const outs = devices || [];
  const ins = micInputs || [];

  // 1) VB-CABLE: пишем в CABLE Input, голосовой чат/Steam читают CABLE Output.
  //    Это самый надёжный маршрут для микширования голоса: кабель ничего не
  //    добавляет от себя, поэтому голос не задваивается.
  //    «Не использовать VB-CABLE» в настройках выключает этот вариант.
  const cableIn = (config && config.cableOff)
    ? null
    : outs.find((d) => /cable/i.test(d.label) && /input/i.test(d.label));
  if (cableIn) {
    const cableOut = ins.find((d) => /cable/i.test(d.label) && /output/i.test(d.label));
    return {
      mode: 'cable',
      name: 'VB-CABLE',
      outId: cableIn.id,
      outLabel: cableIn.label,
      inId: cableOut ? cableOut.id : null,
      inLabel: cableOut ? cableOut.label : 'CABLE Output',
      discord: cableOut ? cableOut.label : 'CABLE Output',
      note: 'VB-CABLE установлен и готов к работе.',
      canTest: !!cableOut
    };
  }

  // 2) SteelSeries Sonar (Classic): двустороннее устройство «Sonar - Microphone».
  //    Проверено на практике: звук, отправленный в его выход, слышен в его входе.
  //    Но голос Sonar подмешивает сам — при включённом микшировании он задвоится.
  const sonarMicOut = outs.find((d) => /sonar/i.test(d.label) && /microphone|микрофон/i.test(d.label));
  if (sonarMicOut) {
    const sonarMicIn = ins.find((d) => /sonar/i.test(d.label) && /microphone|микрофон/i.test(d.label));
    return {
      mode: 'sonar-mic',
      name: 'SteelSeries Sonar',
      outId: sonarMicOut.id,
      outLabel: sonarMicOut.label,
      inId: sonarMicIn ? sonarMicIn.id : null,
      inLabel: sonarMicIn ? sonarMicIn.label : sonarMicOut.label,
      discord: sonarMicIn ? sonarMicIn.label : sonarMicOut.label,
      note: 'Sonar уже установлен. Голос он подмешивает сам — микширование в SoundPulse держи выключенным.',
      canTest: !!sonarMicIn
    };
  }

  // 3) Sonar для стримеров: звук идёт в Media/Gaming/Chat, голосовой чат читает Stream.
  const sonarStreamIn = ins.find((d) => /sonar/i.test(d.label) && /stream/i.test(d.label));
  const sonarPlay = outs.find((d) => /sonar/i.test(d.label) && /media|gaming|chat|aux/i.test(d.label));
  if (sonarPlay && sonarStreamIn) {
    return {
      mode: 'sonar-stream',
      name: 'SteelSeries Sonar (Stream)',
      outId: sonarPlay.id,
      outLabel: sonarPlay.label,
      inId: sonarStreamIn.id,
      inLabel: sonarStreamIn.label,
      discord: sonarStreamIn.label,
      note: 'В Sonar включи «Sonar for Streamers» и укажи Stream Mix = SteelSeries Sonar - Stream.',
      canTest: true
    };
  }

  // 4) Стерео микшер: без установки, но программа услышит ВЕСЬ звук системы.
  const stereo = ins.find((d) => /стерео\s*микшер|stereo\s*mix|what u hear/i.test(d.label));
  if (stereo) {
    const cableExists = outs.some((d) => /cable/i.test(d.label) && /input/i.test(d.label));
    return {
      mode: 'stereo',
      name: 'Стерео микшер',
      outId: '',
      outLabel: 'Системный (динамики)',
      inId: stereo.id,
      inLabel: stereo.label,
      discord: stereo.label,
      note: cableExists
        ? 'VB-CABLE установлен, но отключён в настройках — включи «Использовать VB-CABLE», чтобы не отдавать весь звук системы.'
        : 'Работает без установки. Программа будет слышать весь звук компьютера — лучше в наушниках.',
      canTest: true
    };
  }

  return {
    mode: 'none',
    name: '',
    outId: '',
    outLabel: 'Системный (динамики)',
    inId: null,
    inLabel: '',
    discord: '',
    note: 'Виртуальный микрофон не найден.',
    canTest: false
  };
}

// физический микрофон для голоса (не виртуальный кабель и не стерео микшер)
function physicalMicId() {
  const list = (micInputs || []).filter((d) => !isVirtualMicLabel(d.label));
  const prefer = list.find((d) => /microphone|микрофон|headset|гарнитур|usb/i.test(d.label));
  return (prefer || list[0] || {}).id || '';
}

function micLabel(id) {
  if (!id) return 'системный по умолчанию';
  const d = (micInputs || []).find((x) => x.id === id);
  return d ? d.label : 'выбранный микрофон';
}

// включить/выключить микширование голоса в виртуальный выход
// если автостарт/петля выключили режим — приводим переключатель в настройках в соответствие
function syncVoiceToggle() {
  const el = document.getElementById('s-voice-mix');
  if (el) el.checked = !!config.voiceMix;
}

async function applyVoiceMix() {
  if (!config.voiceMix) { engine.stopVoice(); return false; }
  engine.setVoiceVolume((config.voiceVolume != null ? config.voiceVolume : 100) / 100);
  engine.setVoiceGate(((config.voiceGate != null ? config.voiceGate : 0) / 100) * 0.02);
  const id = config.voiceMicId || physicalMicId();
  const ok = await engine.startVoice(id);
  // защита от петли: если вместо физического микрофона открылся виртуальный
  // (Sonar/CABLE), голос пойдёт сам в себя — выключаем и говорим об этом.
  if (ok) {
    const tr = engine.voiceStream && engine.voiceStream.getAudioTracks()[0];
    const lbl = tr ? (tr.label || '') : '';
    if (lbl && isVirtualMicLabel(lbl)) {
      engine.stopVoice();
      config.voiceMix = false;
      saveConfig();
      syncVoiceToggle();
      toast('Выбран виртуальный микрофон («' + lbl + '») — будет петля. Включи физический', 'error');
      return false;
    }
  }
  if (!ok) {
    config.voiceMix = false;
    saveConfig();
    syncVoiceToggle();
  }
  return ok;
}

// один раз после установки VB-CABLE уводим выход на кабель: иначе звук остаётся
// в Sonar, где голос уже подмешан, и при включённом микшировании он задваивается
function ensureCableRoute() {
  if (config.cableOff || config.cableRouteDone) return false;
  const cable = (devices || []).find((d) => /cable/i.test(d.label) && /input/i.test(d.label));
  if (!cable) return false;
  config.cableRouteDone = true;
  if (config.voiceMix && config.outputDevice !== cable.id) {
    config.outputDevice = cable.id;
    config._noAutoMic = true;
    engine.setMicDevice(cable.id);
    saveConfig();
    toast('Выход переключён на VB-CABLE (CABLE Input) — в Steam или голосовом чате выбери микрофон CABLE Output', 'success');
    return true;
  }
  saveConfig();
  return false;
}

async function refreshDevices() {
  let out = [];
  let ins = [];
  try {
    // БЕЗ getUserMedia метки устройств пустые — автоподбор Sonar/кабеля не найдёт.
    // Просим разрешение один раз: permission handler в main разрешает сам.
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    const devs = await navigator.mediaDevices.enumerateDevices();
    out = devs
      .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label }));
    // физические микрофоны (входы) — не для вывода, но покажем юзеру, что его микрофон найден
    ins = devs
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label }));
  } catch {}
  devices = out;
  micInputs = ins;
  if (window.soundpad && window.soundpad.debug) {
    try { window.soundpad.debug('devices=' + out.map((d) => d.label).join(' | ')); } catch {}
  }
  const isCable = (l) => isVirtualMicLabel(l);
  const route = detectMicRoute();
  cableInputId = route.mode === 'cable' ? route.outId : null;

  // Если выбранное устройство пропало (переустановили Sonar/кабель — id сменился),
  // звук шёл в никуда. Ищем заново.
  const micDead = config.outputDevice && !devices.some((d) => d.id === config.outputDevice);
  if (micDead) { config.outputDevice = ''; engine.setMicDevice(''); toast('Ранее выбранный микрофон не найден — ищу виртуальный кабель заново', 'error'); }

  // автопоиск микрофона: сначала готовый виртуальный маршрут (Sonar / CABLE /
  // Стерео микшер), и только потом «системный по умолчанию».
  // Срабатывает, если юзер ещё выбирал, если девайс пропал ИЛИ выбран «системный
  // по умолчанию» (пустое значение = обычный выход, собеседники его не услышат).
  if (config._autoPickMic || micDead || (!config._noAutoMic && !config.outputDevice)) {
    const was = config.outputDevice;
    const pickId = route.outId || '';
    config.outputDevice = pickId;
    engine.setMicDevice(pickId);
    if (pickId && was !== pickId) {
      toast('Микрофон: ' + route.outLabel + ' → в программе выбери «' + route.discord + '»', 'success');
    }
  } else {
    engine.setMicDevice(config.outputDevice);
  }

  // дакинг слушает физический микрофон, а не виртуальный (иначе он «слышит»
  // собственный звук SoundPulse и приглушает сам себя)
  const physMic = micInputs.find((d) => !isVirtualMicLabel(d.label));
  engine.setDuckDevice(physMic ? physMic.id : '');

  // автопоиск динамиков: никогда не берём кабель/входные — иначе не будет слышно себя.
  // Если подходящего нет — системный по умолчанию ('').
  if (config._autoPickSpk) {
    const spk = devices.find((d) => !isCable(d.label) && /speaker|динамик|headphone|наушник|output/i.test(d.label) && d.id !== config.outputDevice);
    if (spk) {
      config.speakerDevice = spk.id;
      engine.setSpeakerDevice(spk.id);
    } else {
      engine.setSpeakerDevice('');
    }
  } else {
    engine.setSpeakerDevice(config.speakerDevice);
  }

  saveConfig();
}

function deviceLabel(id) {
  const d = devices.find((x) => x.id === id);
  return d ? d.label : 'системное по умолчанию';
}

// ---------------- CRUD ----------------

async function addSoundFiles(fileInfos, categoryId) {
  let cat = categoryId;
  if (cat === undefined || cat === null) cat = (currentCategory && currentCategory !== 'all' && currentCategory !== 'none') ? currentCategory : 'default';
  let added = 0;
  for (const f of fileInfos) {
    if (!f || !f.path) continue;
    if (config.sounds.some((s) => s.path === f.path)) continue;
    const s = {
      id: 's_' + randomId(),
      name: stripExt(f.name),
      path: f.path,
      category: cat,
      volume: 1,
      rate: 1,
      offset: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
      plays: 0,
      mode: 'mic',
      hotkey: null
    };
    config.sounds.push(s);
    sounds.set(s.id, s);
    added++;
  }
  if (added) {
    saveConfig();
    render();
    toast('Добавлено звуков: ' + added, 'success');
  }
}

async function pickAndAdd() {
  const files = await api.pickSounds();
  if (files && files.length) addSoundFiles(files);
}

async function pickFolder() {
  const res = await api.pickFolder();
  if (!res) return;
  if (!res.files.length) { toast('В папке нет аудиофайлов', 'error'); return; }
  const c = { id: 'c_' + randomId(), name: res.name };
  config.categories.push(c);
  currentCategory = c.id;
  addSoundFiles(res.files, c.id);
}

function deleteSound(id) {
  const s = sounds.get(id);
  if (!s) return;
  if (s.playing) finishSound(s, true);
  if (s.hotkey) {
    delete hotkeyMap[s.id];
    api.hotkeysSet(hotkeyMap);
  }
  config.sounds = config.sounds.filter((x) => x.id !== id);
  sounds.delete(id);
  engine.buffers.delete(s.path);
  engine.normGain.delete(s.path);
  saveConfig();
  hideContextMenu();
  render();
}

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------- categories ----------------

function addCategory() {
  promptModal('Новый набор', 'Название набора:', '', (value) => {
    const name = value.trim();
    if (!name) return false;
    if (config.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      toast('Набор с таким именем уже есть', 'error');
      return false;
    }
    const c = { id: 'c_' + randomId(), name };
    config.categories.push(c);
    saveConfig();
    currentCategory = c.id;
    render();
    return true;
  }, 'Создать');
}

function renameCategory(id) {
  const c = config.categories.find((x) => x.id === id);
  if (!c) return;
  promptModal('Переименовать набор', 'Новое название:', c.name, (value) => {
    const name = value.trim();
    if (!name) return false;
    c.name = name;
    saveConfig();
    render();
    return true;
  });
}

function deleteCategory(id) {
  const c = config.categories.find((x) => x.id === id);
  if (!c) return;
  const count = config.sounds.filter((s) => s.category === id).length;
  const act = () => {
    for (const s of config.sounds) if (s.category === id) s.category = '';
    config.categories = config.categories.filter((x) => x.id !== id);
    if (currentCategory === id) currentCategory = 'all';
    saveConfig();
    render();
  };
  if (count > 0) {
    confirmModal('Удалить набор «' + c.name + '»?', 'Звуков в наборе: ' + count + '. Они останутся во «Все звуки».', act);
  } else {
    act();
  }
}

// ---------------- context menu ----------------

let cmSoundId = null;
let cmIdx = 0;
const cmEl = document.getElementById('context-menu');

function openContextMenu(x, y, soundId) {
  const s = sounds.get(soundId);
  if (!s) return;
  cmSoundId = soundId;
  cmIdx = 0;
  cmEl.innerHTML = '';

  cmEl.appendChild(cmItem(s.playing ? 'Остановить' : 'Воспроизвести', s.playing ? ico('stop') : ico('play'), () => playSound(soundId)));
  cmEl.appendChild(cmItem('Назначить горячую клавишу...', ico('bolt'), () => hotkeyModal(s)));
  cmEl.appendChild(cmItem('Свойства...', null, () => propertiesModal(s)));
  cmEl.appendChild(cmItem('Громкость...', ico('volume'), () => volumeModal(s)));
  cmEl.appendChild(cmItem('Переименовать...', ico('pencil'), () => promptModal('Переименовать', 'Новое имя звука:', s.name, (v) => {
    const name = v.trim();
    if (!name) return false;
    s.name = name;
    saveConfig();
    render();
    return true;
  })));

  cmEl.appendChild(cmItem('Куда играть...', ico('volume'), () => modeModal(s)));
  cmEl.appendChild(cmItem('Переместить в...', ico('move'), () => moveModal(s)));

  const sep = document.createElement('div');
  sep.className = 'cm-sep';
  cmEl.appendChild(sep);
  cmEl.appendChild(cmItem('Удалить', '\u2715', () => deleteSound(soundId), true));

  showContextMenu(x, y);
}

function modeModal(s) {
  const rows = [['mic', 'Только в микрофон', 'голосовой чат в игре'], ['speakers', 'Только в динамики', 'обычное проигрывание'], ['both', 'В микрофон и динамики', 'и туда, и туда']];
  openModal('Куда играть: ' + s.name,
    '<div class="set-group">' + rows.map(([val, name, desc]) =>
      '<div class="set-row" data-mode="' + val + '"><div class="set-label"><div class="set-name">' + name + '</div>' +
      '<div class="set-desc">' + desc + '</div></div>' +
      '<div class="set-ctrl"><span class="volume" style="font-size:15px;color:#50e69d" data-chk="' + val + '">' + (s.mode === val ? '\u2713' : '\u00a0\u00a0') + '</span></div></div>'
    ).join('') + '</div>',
    '<button class="small-btn" id="m-cancel">Отмена</button>');
  const mark = (val) => {
    rows.forEach(([v]) => {
      document.querySelector('[data-chk="' + v + '"]').textContent = v === val ? '\u2713' : '\u00a0\u00a0';
    });
  };
  rows.forEach(([val]) => {
    document.querySelector('[data-mode="' + val + '"]').addEventListener('click', () => {
      s.mode = val;
      mark(val);
      saveConfig();
      toast('Куда играть: ' + (rows.find((r) => r[0] === val) || [])[1].toLowerCase(), 'success');
    });
  });
  document.getElementById('m-cancel').addEventListener('click', () => { saveConfig(); closeModal(); });
}

function moveModal(s) {
  const rows = [{ id: '', name: 'Без набора', desc: 'останется на главной странице' }].concat(config.categories.map((c) => ({ id: c.id, name: c.name, desc: 'набор «' + c.name + '»' })));
  openModal('Переместить: ' + s.name,
    '<div class="set-group">' + rows.map((r) =>
      '<div class="set-row" data-cat="' + r.id + '"><div class="set-label"><div class="set-name">' + escapeHtml(r.name) + '</div>' +
      '<div class="set-desc">' + escapeHtml(r.desc) + '</div></div>' +
      '<div class="set-ctrl"><span class="volume" style="font-size:15px;color:#50e69d" data-mvchk="' + r.id + '">' + ((s.category || '') === r.id ? '\u2713' : '\u00a0\u00a0') + '</span></div></div>'
    ).join('') + '</div>',
    '<button class="small-btn" id="m-cancel">Отмена</button>');
  const mark = (id) => {
    rows.forEach((r) => {
      document.querySelector('[data-mvchk="' + r.id + '"]').textContent = r.id === id ? '\u2713' : '\u00a0\u00a0';
    });
  };
  rows.forEach((r) => {
    document.querySelector('[data-cat="' + r.id + '"]').addEventListener('click', () => {
      s.category = r.id;
      mark(r.id);
      saveConfig();
      render();
      closeModal();
      toast('Перемещено в «' + r.name + '»', 'success');
    });
  });
  document.getElementById('m-cancel').addEventListener('click', () => { saveConfig(); closeModal(); });
}

function cmItem(label, icon, action, danger, checked) {
  const el = document.createElement('div');
  el.className = 'cm-item' + (danger ? ' danger' : '') + (checked ? ' checked' : '');
  el.style.setProperty('--i', String(cmIdx++));
  if (icon !== null) {
    const ic = document.createElement('span');
    ic.className = 'cm-icon';
    if (typeof icon === 'string' && icon.indexOf('<svg') === 0) ic.innerHTML = icon;
    else ic.textContent = icon;
    el.appendChild(ic);
  }
  const t = document.createElement('span');
  t.textContent = label;
  el.appendChild(t);
  el.addEventListener('click', () => { hideContextMenu(); action(); });
  return el;
}

let cmHidTimer = null;

function showContextMenu(x, y) {
  if (cmHidTimer) { clearTimeout(cmHidTimer); cmHidTimer = null; }
  cmEl.classList.remove('closing');
  cmEl.classList.remove('hidden');
  const w = cmEl.offsetWidth, h = cmEl.offsetHeight; // без transform-анимации
  cmEl.style.left = Math.min(x, window.innerWidth - w - 10) + 'px';
  cmEl.style.top = Math.min(y, window.innerHeight - h - 10) + 'px';
}

function hideContextMenu() {
  if (cmHidTimer) clearTimeout(cmHidTimer);
  cmEl.classList.add('closing');
  cmHidTimer = setTimeout(() => {
    cmEl.classList.add('hidden');
    cmEl.classList.remove('closing');
    cmHidTimer = null;
  }, 140);
  cmSoundId = null;
}

function closeRequestedModal() {
  openModal('Закрыть SoundPulse?',
    '<div class="set-group"><div class="set-desc" style="margin:2px 4px 6px;font-size:12.5px">Свернуть в трей — горячие клавиши и звуки продолжат работать.<br>Выйти — приложение полностью закроется.</div></div>',
    '<button class="small-btn" id="m-tray">Свернуть в трей</button><button class="small-btn" id="m-quit">Выйти</button>');
  document.getElementById('m-tray').addEventListener('click', () => { closeModal(); winAnimate(() => api.windowControls.hide()); });
  document.getElementById('m-quit').addEventListener('click', () => { closeModal(); winAnimate(() => api.windowControls.quit()); });
}

// плавное «схлопывание» окна перед сворачиванием/закрытием
function winAnimate(action) {
  document.body.classList.add('win-closing');
  setTimeout(() => { document.body.classList.remove('win-closing'); action(); }, 200);
}

// ---------------- modals ----------------

let modalCloseTimer = null;

function openModal(title, bodyHTML, actionsHTML) {
  closeModal();
  uiSound('open');
  if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; }
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  document.getElementById('modal-actions').innerHTML = actionsHTML || '';
  const ov = document.getElementById('modal-overlay');
  ov.classList.remove('closing');
  ov.classList.remove('hidden');
  return document.getElementById('modal');
}

function closeModal() {
  const ov = document.getElementById('modal-overlay');
  if (!ov.classList.contains('hidden')) uiSound('close');
  if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; }
  ov.classList.add('closing');
  modalCloseTimer = setTimeout(() => {
    ov.classList.add('hidden');
    ov.classList.remove('closing');
  }, 160);
  recorderCleanup();
  if (typeof stopMicProbe === 'function' && stopMicProbe) stopMicProbe();
  if (hkCaptureActive) { hkCaptureActive = false; api.suppressHotkeys(false); }
}

function modalBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// тумблер в стиле Telegram
function sw(id, on) {
  return '<label class="switch"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><i></i></label>';
}

function promptModal(title, label, initial, onOk, okLabel) {
  openModal(title,
    '<div class="set-group"><div class="set-row"><div class="set-label"><div class="set-name">' + label + '</div></div></div>' +
    '<div class="set-row" style="border:none;padding-top:0"><input type="text" id="modal-input" value="' + escapeHtml(initial || '') + '" /></div></div>',
    '<button class="small-btn" id="m-cancel">Отмена</button><button class="small-btn" id="m-ok">' + (okLabel || 'OK') + '</button>');
  const input = document.getElementById('modal-input');
  input.focus();
  input.select();
  const ok = () => {
    const r = onOk(input.value);
    if (r) closeModal();
  };
  document.getElementById('m-ok').addEventListener('click', ok);
  document.getElementById('m-cancel').addEventListener('click', closeModal);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ok(); }
  });
}

function confirmModal(title, message, onOk) {
  openModal(title,
    '<div class="set-group"><div class="set-desc" style="margin:2px 4px 6px">' + message + '</div></div>',
    '<button class="small-btn" id="m-cancel">Отмена</button><button class="small-btn" id="m-yes" style="color:#fff;background:rgba(255,90,105,.3)">Удалить</button>');
  document.getElementById('m-yes').addEventListener('click', () => { closeModal(); onOk(); });
  document.getElementById('m-cancel').addEventListener('click', closeModal);
}

function volumeModal(s) {
  const v = Math.round((typeof s.volume === 'number' ? s.volume : 1) * 100);
  openModal('Громкость: ' + s.name,
    '<div class="set-group"><div class="set-row"><div class="set-label"><div class="set-name">Громкость</div>' +
    '<div class="set-desc">0–200%, 100% — исходная</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" id="vol-input" min="0" max="200" value="' + v + '"><span class="volume" id="vol-out" style="width:52px">' + v + '%</span></div></div></div>',
    '<button class="small-btn" id="m-cancel">Отмена</button><button class="small-btn" id="m-ok">OK</button>');
  const input = document.getElementById('vol-input');
  const out = document.getElementById('vol-out');
  input.addEventListener('input', () => {
    out.textContent = input.value + '%';
    s.volume = input.value / 100;
    if (s.playing && s._handle) s._handle.setVolume(s.volume);
  });
  document.getElementById('m-ok').addEventListener('click', () => {
    s.volume = input.value / 100;
    saveConfig();
    closeModal();
    render();
  });
  document.getElementById('m-cancel').addEventListener('click', () => { render(); closeModal(); });
}

function propertiesModal(s) {
  const v = Math.round((typeof s.volume === 'number' ? s.volume : 1) * 100);
  const sp = Math.round((s.rate || 1) * 100);
  openModal('Свойства: ' + s.name,
    '<div class="set-group">' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Громкость</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" min="0" max="200" value="' + v + '" id="p-vol"><span class="volume" style="width:52px" id="p-vol-out">' + v + '%</span></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Скорость</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" min="50" max="200" value="' + sp + '" id="p-rate"><span class="volume" style="width:52px" id="p-rate-out">' + sp + '%</span></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Начать с (сек)</div>' +
    '<div class="set-desc">точка отступа внутри трека</div></div>' +
    '<div class="set-ctrl"><input type="text" id="p-offset" style="width:64px;margin-top:0" value="' + (s.offset || 0) + '"></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Затухание в начале, сек</div></div>' +
    '<div class="set-ctrl"><input type="text" id="p-fadein" style="width:64px;margin-top:0" value="' + (+s.fadeIn || 0) + '"></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Затухание в конце, сек</div></div>' +
    '<div class="set-ctrl"><input type="text" id="p-fadeout" style="width:64px;margin-top:0" value="' + (+s.fadeOut || 0) + '"></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Зациклить</div>' +
    '<div class="set-desc">играть по кругу до остановки</div></div>' + sw('p-loop', s.loop) + '</div>' +
    '<div class="set-row" style="border:none"><div class="set-label"><div class="set-name">Клавиша</div></div>' +
    '<div class="set-ctrl"><span class="volume" style="color:#ffd479" id="p-key">' + (s.hotkey ? prettyHotkey(s.hotkey) : '—') + '</span><button class="small-btn" id="p-keybtn">Назначить</button></div></div>' +
    '</div>',
    '<button class="small-btn" id="m-folder">В проводнике</button><button class="small-btn" id="m-test">' + ico('play') + 'Тест</button><button class="small-btn" id="m-cancel">Отмена</button><button class="small-btn" id="m-ok">OK</button>');

  const read = (id) => {
    const e = document.getElementById(id);
    return e ? e.value : null;
  };
  document.getElementById('p-vol').addEventListener('input', () => {
    document.getElementById('p-vol-out').textContent = document.getElementById('p-vol').value + '%';
    s.volume = document.getElementById('p-vol').value / 100;
    if (s.playing && s._handle) s._handle.setVolume(s.volume);
  });
  document.getElementById('p-rate').addEventListener('input', () => {
    document.getElementById('p-rate-out').textContent = document.getElementById('p-rate').value + '%';
  });
  document.getElementById('p-keybtn').addEventListener('click', () => {
    document.getElementById('m-cancel').click();
    setTimeout(() => hotkeyModal(s), 50);
  });
  document.getElementById('m-test').addEventListener('click', () => {
    s.rate = Number(read('p-rate')) / 100 || 1;
    s.offset = Math.max(0, parseFloat(read('p-offset')) || 0);
    s.fadeIn = Math.max(0, parseFloat(read('p-fadein')) || 0);
    s.fadeOut = Math.max(0, parseFloat(read('p-fadeout')) || 0);
    s.loop = document.getElementById('p-loop').checked;
    playSound(s.id, { rate: s.rate });
  });
  document.getElementById('m-folder').addEventListener('click', () => {
    api.showItem(s.path);
    closeModal();
  });
  document.getElementById('m-ok').addEventListener('click', () => {
    s.volume = Math.max(0, Number(read('p-vol')) / 100); if (!(s.volume >= 0)) s.volume = 1;
    s.rate = Math.max(0.5, Math.min(2, Number(read('p-rate')) / 100 || 1));
    s.offset = Math.max(0, parseFloat(read('p-offset')) || 0);
    s.fadeIn = Math.max(0, parseFloat(read('p-fadein')) || 0);
    s.fadeOut = Math.max(0, parseFloat(read('p-fadeout')) || 0);
    s.loop = document.getElementById('p-loop').checked;
    saveConfig();
    closeModal();
    render();
  });
  document.getElementById('m-cancel').addEventListener('click', () => { render(); closeModal(); });
}

function hotkeyModal(s) {
  openModal('Горячая клавиша: ' + s.name,
    '<div class="set-group"><div class="set-desc" style="margin:2px 4px 8px;font-size:12px">Нажмите клавишу или сочетание. Одинарные буквы/цифры работают, пока открыто окно SoundPulse (или как вторая клавиша после /, если включён режим "/" в Настройках); F-клавиши и сочетания с Ctrl/Alt/Shift работают всегда, даже в игре.</div>' +
    '<div class="set-row" style="border:none;justify-content:center"><div class="key-capture" id="key-capture">Нажмите клавишу...</div></div></div>',
    '<button class="small-btn" id="m-clear">Убрать клавишу</button><button class="small-btn" id="m-cancel">Отмена</button>');
  const cap = document.getElementById('key-capture');
  cap.classList.add('capturing');
  cap.tabIndex = 0;
  cap.focus();
  hkCaptureActive = true;
  api.suppressHotkeys(true);

  let done = false;
  const finish = (acc) => {
    if (done) return;
    done = true;
    hkCaptureActive = false;
    api.suppressHotkeys(false);
    const doApply = async (val) => {
      if (!val) return;
      if (val === 'F8') { toast('F8 занято (Стоп)', 'error'); return; }
      if (/^Ctrl\+Alt\+[0-9]$/.test(val)) { toast('Ctrl+Alt+цифра занято быстрым запуском', 'error'); return; }
      if (Object.values(hotkeyMap).includes(val)) { toast('Сочетание уже занято другим звуком', 'error'); return; }
      pendingHotkey = { s, prev: s.hotkey, accel: val };
      const next = { ...hotkeyMap, [s.id]: val };
      await api.hotkeysSet(next);
      hotkeyMap = next;
      s.hotkey = val;
      saveConfig();
      render();
      toast('Клавиша ' + prettyHotkey(val) + ' назначена', 'success');
    };
    closeModal();
    doApply(acc);
  };

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { removeKeyHandler(); finish(null); return; }
    if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    const key = keyFromEvent(e);
    if (!key) return;
    removeKeyHandler();
    finish([...mods, key].join('+'));
  };
  function removeKeyHandler() {
    document.removeEventListener('keydown', handler, true);
  }
  document.addEventListener('keydown', handler, true);

  document.getElementById('m-clear').addEventListener('click', () => {
    delete hotkeyMap[s.id];
    api.hotkeysSet(hotkeyMap);
    s.hotkey = null;
    saveConfig();
    render();
    removeKeyHandler();
    finish(null);
  });
  document.getElementById('m-cancel').addEventListener('click', () => { removeKeyHandler(); finish(null); });
}

function keyFromEvent(e) {
  const code = e.code || '';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'PrintScreen'].includes(code)) return code;
  const PUNCT = {
    Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Minus: '-', Equal: '=',
    Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']'
  };
  if (PUNCT[code]) return PUNCT[code];
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return null;
}

const PUNCT_SYMBOLS = {
  Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Minus: '-', Equal: '=',
  Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']'
};

function prettyHotkey(acc) {
  if (!acc) return '';
  return acc.split('+').map((p) => PUNCT_SYMBOLS[p] || p).join('+').replace(/CommandOrControl/g, 'Ctrl');
}

// ---------- settings modal ----------

// ---------------- настройка вида (встроенное окно, как настройки) ----------------
const CUSTOM_PRESETS = {
  classic: { accent: '#55a9ff', radius: 22, cardScale: 1, bgDim: 78, aurora: true, anims: true, animSpeed: 1, tilt: true, blur: true },
  glass: { accent: '#7fd7ff', radius: 26, cardScale: 1, bgDim: 62, aurora: true, anims: true, animSpeed: 1, tilt: true, blur: true },
  minimal: { accent: '#9aa7bd', radius: 12, cardScale: 0.95, bgDim: 92, aurora: false, anims: false, animSpeed: 0.8, tilt: false, blur: false },
  neon: { accent: '#b06bff', radius: 20, cardScale: 1.05, bgDim: 55, aurora: true, anims: true, animSpeed: 1.2, tilt: true, blur: true }
};
const CUSTOM_SWATCHES = ['#55a9ff', '#7fd7ff', '#50e69d', '#ffd479', '#ff8a5c', '#ff6f8b', '#b06bff', '#c9d4e6'];

function customizeModal() {
  const body =
    '<div class="set-group">' +
      '<div class="set-group-title">Пресеты</div>' +
      '<div class="cust-presets">' +
        '<button class="cust-preset" data-preset="classic"><span class="cust-dot" data-c="#55a9ff"></span>Классика</button>' +
        '<button class="cust-preset" data-preset="glass"><span class="cust-dot" data-c="#7fd7ff"></span>Стекло</button>' +
        '<button class="cust-preset" data-preset="minimal"><span class="cust-dot" data-c="#9aa7bd"></span>Минимал</button>' +
        '<button class="cust-preset" data-preset="neon"><span class="cust-dot" data-c="#b06bff"></span>Неон</button>' +
      '</div>' +
    '</div>' +
    '<div class="set-group">' +
      '<div class="set-group-title">Акцентный цвет</div>' +
      '<div class="cust-swatches">' +
        CUSTOM_SWATCHES.map((c) => '<button class="cust-sw' + (String(config.accent).toLowerCase() === c ? ' active' : '') + '" data-color="' + c + '" title="' + c + '"></button>').join('') +
        '<input type="color" id="s-accent" value="' + (config.accent || '#55a9ff') + '" title="Свой цвет">' +
      '</div>' +
    '</div>' +
    '<div class="set-group">' +
      '<div class="set-group-title">Карточки</div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Скругление</div>' +
      '<div class="set-desc">насколько круглые углы у карточек</div></div>' +
      '<div class="set-ctrl"><input class="range" type="range" id="s-radius" min="6" max="32" value="' + (config.radius != null ? config.radius : 22) + '"><span class="volume" id="s-radius-out" style="width:46px">' + (config.radius != null ? config.radius : 22) + ' px</span></div></div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Размер карточек</div>' +
      '<div class="set-desc">80–130% от обычного</div></div>' +
      '<div class="set-ctrl"><input class="range" type="range" id="s-card-scale" min="80" max="130" value="' + Math.round((config.cardScale || 1) * 100) + '"><span class="volume" id="s-card-scale-out" style="width:46px">' + Math.round((config.cardScale || 1) * 100) + '%</span></div></div>' +
    '</div>' +
    '<div class="set-group">' +
      '<div class="set-group-title">Фон</div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Затемнение</div>' +
      '<div class="set-desc">чем больше — тем темнее картинка фона</div></div>' +
      '<div class="set-ctrl"><input class="range" type="range" id="s-bg-dim" min="0" max="95" value="' + (config.bgDim != null ? config.bgDim : 78) + '"><span class="volume" id="s-bg-dim-out" style="width:46px">' + (config.bgDim != null ? config.bgDim : 78) + '%</span></div></div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Картинка фона</div></div>' +
      '<div class="set-ctrl"><button class="small-btn" id="s-bg-pick">Выбрать</button><button class="small-btn" id="s-bg-clear">Убрать</button></div></div>' +
      '<img id="s-bg-preview" alt="" />' +
      '<div class="set-desc" id="s-bg-name">' + (config.background ? 'Фон задан' : 'Фона нет') + '</div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Подсветка фона (aurora)</div>' +
      '<div class="set-desc">цветные пятна на заднем плане</div></div>' + sw('s-aurora', config.aurora !== false) + '</div>' +
    '</div>' +
    '<div class="set-group">' +
      '<div class="set-group-title">Эффекты</div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Размытие фона</div>' +
      '<div class="set-desc">мягкое размытие заднего плана за панелями</div></div>' + sw('s-blur', config.blur !== false) + '</div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Анимации</div>' +
      '<div class="set-desc">появление карточек, наведение, переходы</div></div>' + sw('s-anims', config.anims !== false) + '</div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">Скорость анимаций</div></div>' +
      '<div class="set-ctrl"><input class="range" type="range" id="s-anim-speed" min="60" max="160" step="5" value="' + Math.round((config.animSpeed || 1) * 100) + '"><span class="volume" id="s-anim-speed-out" style="width:46px">' + Math.round((config.animSpeed || 1) * 100) + '%</span></div></div>' +
      '<div class="set-row"><div class="set-label"><div class="set-name">3D-наклон карточек</div>' +
      '<div class="set-desc">карточка слегка поворачивается за мышкой</div></div>' + sw('s-tilt', config.tilt !== false) + '</div>' +
    '</div>';

  openModal('Настройка вида', body, '<button class="small-btn" id="m-cancel">Закрыть</button>');
  document.getElementById('m-cancel').addEventListener('click', closeModal);
  syncGlassModeUi();

  const bgPreview = document.getElementById('s-bg-preview');
  const setOut = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };

  // цвета задаём через CSSOM: CSP запрещает инлайновые style-атрибуты
  document.querySelectorAll('.cust-sw').forEach((b) => b.style.setProperty('--c', b.dataset.color));
  document.querySelectorAll('.cust-dot').forEach((d) => d.style.setProperty('--c', d.dataset.c));
  if (bgPreview) {
    if (config.background) { bgPreview.src = config.background; bgPreview.style.display = 'block'; }
    else bgPreview.style.display = 'none';
  }

  // пресеты
  document.querySelectorAll('.cust-preset').forEach((b) => {
    b.addEventListener('click', () => {
      const p = CUSTOM_PRESETS[b.dataset.preset];
      if (!p) return;
      Object.assign(config, p);
      applyAppearance();
      applyBackground();
      applyBlur();
      updateBlurUi();
      render();
      saveConfig();
      syncAll();
    });
  });

  function syncAll() {
    document.getElementById('s-radius').value = config.radius;
    setOut('s-radius-out', config.radius + ' px');
    document.getElementById('s-card-scale').value = Math.round((config.cardScale || 1) * 100);
    setOut('s-card-scale-out', Math.round((config.cardScale || 1) * 100) + '%');
    document.getElementById('s-bg-dim').value = config.bgDim != null ? config.bgDim : 78;
    setOut('s-bg-dim-out', (config.bgDim != null ? config.bgDim : 78) + '%');
    document.getElementById('s-anim-speed').value = Math.round((config.animSpeed || 1) * 100);
    setOut('s-anim-speed-out', Math.round((config.animSpeed || 1) * 100) + '%');
    document.getElementById('s-aurora').checked = config.aurora !== false;
    document.getElementById('s-anims').checked = config.anims !== false;
    document.getElementById('s-tilt').checked = config.tilt !== false;
    syncGlassModeUi();
    document.getElementById('s-accent').value = config.accent || '#55a9ff';
    document.querySelectorAll('.cust-sw').forEach((b) => {
      b.classList.toggle('active', b.dataset.color.toLowerCase() === String(config.accent).toLowerCase());
    });
  }

  // акцент
  const setAccent = (c) => {
    config.accent = c;
    applyAppearance();
    saveConfig();
    document.querySelectorAll('.cust-sw').forEach((b) => {
      b.classList.toggle('active', b.dataset.color.toLowerCase() === String(c).toLowerCase());
    });
    const ci = document.getElementById('s-accent');
    if (ci) ci.value = c;
  };
  document.querySelectorAll('.cust-sw').forEach((b) => {
    b.addEventListener('click', () => setAccent(b.dataset.color));
  });
  document.getElementById('s-accent').addEventListener('input', (e) => setAccent(e.target.value));

  // карточки и фон
  document.getElementById('s-radius').addEventListener('input', (e) => {
    config.radius = +e.target.value;
    setOut('s-radius-out', e.target.value + ' px');
    applyAppearance();
  });
  document.getElementById('s-radius').addEventListener('change', () => saveConfig());

  document.getElementById('s-card-scale').addEventListener('input', (e) => {
    config.cardScale = e.target.value / 100;
    setOut('s-card-scale-out', e.target.value + '%');
    applyAppearance();
    render();
  });
  document.getElementById('s-card-scale').addEventListener('change', () => saveConfig());

  document.getElementById('s-bg-dim').addEventListener('input', (e) => {
    config.bgDim = +e.target.value;
    setOut('s-bg-dim-out', e.target.value + '%');
    applyBackground();
  });
  document.getElementById('s-bg-dim').addEventListener('change', () => saveConfig());

  document.getElementById('s-bg-pick').addEventListener('click', async () => {
    const res = await api.pickImage();
    if (!res || !res.ok) {
      if (res && res.error) toast(res.error, 'error');
      return;
    }
    config.background = res.dataURL;
    applyBackground();
    if (bgPreview) { bgPreview.src = config.background; bgPreview.style.display = 'block'; }
    setOut('s-bg-name', 'Фон: ' + res.name);
    saveConfig();
  });
  document.getElementById('s-bg-clear').addEventListener('click', () => {
    config.background = '';
    applyBackground();
    if (bgPreview) bgPreview.style.display = 'none';
    setOut('s-bg-name', 'Фона нет');
    saveConfig();
  });

  document.getElementById('s-aurora').addEventListener('change', (e) => {
    config.aurora = e.target.checked;
    applyAppearance();
    saveConfig();
  });
  document.getElementById('s-anims').addEventListener('change', (e) => {
    config.anims = e.target.checked;
    applyAppearance();
    saveConfig();
  });
  document.getElementById('s-tilt').addEventListener('change', (e) => {
    config.tilt = e.target.checked;
    applyAppearance();
    saveConfig();
  });
  const blurSw = document.getElementById('s-blur');
  if (blurSw) blurSw.addEventListener('change', (e) => setBlur(e.target.checked));
  document.getElementById('s-anim-speed').addEventListener('input', (e) => {
    config.animSpeed = e.target.value / 100;
    setOut('s-anim-speed-out', e.target.value + '%');
    applyAppearance();
  });
  document.getElementById('s-anim-speed').addEventListener('change', () => saveConfig());
}

function settingsModal() {
  const micVal = config.outputDevice;
  const spkVal = config.speakerDevice;
  const isMicOut = (l) => isVirtualMicLabel(l);
  const deviceDropdown = (value, kind, onPick, list) => {
    const wrap = document.createElement('div');
    wrap.className = 'dev-dd';
    const pool = list || devices;
    const items = [{ id: '', name: kind === 'voice' ? 'Авто — физический микрофон' : 'Системный (по умолчанию)' }].concat(pool.map((d) => ({ id: d.id, name: d.label })));
    const itemName = (id) => { const it = items.find((x) => x.id === id); return it ? it.name : items[0].name; };
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dev-dd-trigger';
    const trigText = document.createElement('span');
    trigText.className = 'dev-name';
    trigText.textContent = itemName(value);
    const chev = document.createElement('span');
    chev.className = 'dev-chev';
    chev.innerHTML = '<svg class="ic"><use href="#i-chev"/></svg>';
    trigger.appendChild(trigText);
    trigger.appendChild(chev);
    const body = document.createElement('div');
    body.className = 'dev-dd-body';
    const renderBody = () => {
      body.textContent = '';
      for (const it of items) {
        const o = document.createElement('button');
        o.type = 'button';
        o.className = 'dev-item' + (it.id === value ? ' active' : '');
        const n = document.createElement('span');
        n.className = 'dev-name';
        n.textContent = it.name;
        o.appendChild(n);
        if (kind === 'mic' && it.id) {
          const micLike = isMicOut(it.name);
          const tag = document.createElement('span');
          tag.className = 'dev-tag';
          tag.textContent = micLike ? 'вирт. микрофон' : 'динамики';
          tag.style.color = micLike ? '#7de0a4' : '#7581ab';
          o.appendChild(tag);
        }
        if (kind === 'voice' && it.id) {
          const virt = isVirtualMicLabel(it.name);
          const tag = document.createElement('span');
          tag.className = 'dev-tag';
          tag.textContent = virt ? 'виртуальный' : 'микрофон';
          tag.style.color = virt ? '#ffb45e' : '#7de0a4';
          o.appendChild(tag);
        }
        o.addEventListener('click', () => {
          value = it.id;
          trigText.textContent = itemName(it.id);
          renderBody();
          wrap.classList.remove('open');
          onPick(it.id);
        });
        body.appendChild(o);
      }
    };
    trigger.addEventListener('click', () => {
      for (const d of document.querySelectorAll('.dev-dd.open')) if (d !== wrap) d.classList.remove('open');
      wrap.classList.toggle('open');
    });
    renderBody();
    wrap.appendChild(trigger);
    wrap.appendChild(body);
    return wrap;
  };

  const body =
    '<div class="set-group">' +
    '<div class="set-group-title">Устройства</div>' +
    '<div class="set-dev-row"><div class="set-dev-title">Микрофон (выход)</div>' +
    '<div class="set-dev-sub">Куда SoundPulse шлёт звук. Собеседник услышит, если выбран виртуальный микрофон (Sonar / CABLE)</div></div>' +
    '<div id="dev-mic"></div>' +
    '<div class="set-desc" id="mic-warn" style="padding:4px 4px 0 4px"></div>' +
    '<div class="set-row" style="margin-top:6px"><div class="set-label"><div class="set-name">Подключение к голосовой чат</div>' +
    '<div class="set-desc" id="mic-route-sum">проверю маршрут и покажу, какой микрофон выбрать</div></div>' +
    '<div class="set-ctrl"><button class="small-btn" id="s-mic-wizard">Мастер</button></div></div>' +
    '<div class="set-dev-row" style="margin-top:14px"><div class="set-dev-title">Динамики, выход</div>' +
    '<div class="set-dev-sub">Куда SoundPulse играет тебе в уши</div></div>' +
    '<div id="dev-spk"></div>' +
    '</div>' +
    '<div class="set-group">' +
    '<div class="set-group-title">Голос в микрофон</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">SoundPulse микширует мой голос</div>' +
    '<div class="set-desc">голос + звуки в один виртуальный микрофон. Включай при VB-CABLE. Если голос уже даёт Sonar — оставь выключенным, иначе голос задвоится</div></div>' + sw('s-voice-mix', config.voiceMix) + '</div>' +
    '<div class="set-dev-row" style="margin-top:8px"><div class="set-dev-title">Микрофон для голоса</div>' +
    '<div class="set-dev-sub">физический микрофон — SoundPulse его слушает и подмешивает в выход выше</div></div>' +
    '<div id="dev-voice-mic"></div>' +
    '<div class="set-row" style="margin-top:10px"><div class="set-label"><div class="set-name">Громкость голоса</div>' +
    '<div class="set-desc">100% — микрофон как есть. Голос идёт мимо эффектов и мимо ползунка «Громкость»</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" id="s-voice-vol" min="0" max="200" value="' + Math.round(config.voiceVolume != null ? config.voiceVolume : 100) + '"><span class="volume" id="s-voice-vol-out" style="width:46px">' + Math.round(config.voiceVolume != null ? config.voiceVolume : 100) + '%</span></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Шумовые ворота</div>' +
    '<div class="set-desc">тише порога — микрофон закрыт, меньше шума в эфире; 0 = выключено</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" id="s-voice-gate" min="0" max="100" value="' + Math.round(config.voiceGate != null ? config.voiceGate : 0) + '"><span class="volume" id="s-voice-gate-out" style="width:46px">' + Math.round(config.voiceGate != null ? config.voiceGate : 0) + '%</span></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Уровень голоса</div>' +
    '<div class="set-desc">индикатор того, что реально уходит собеседнику</div></div>' +
    '<div class="set-ctrl"><div class="mic-test-meter" id="s-voice-meter" style="width:120px;display:block"><i></i></div></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Не использовать VB-CABLE</div>' +
    '<div class="set-desc">для тех, у кого уже есть виртуальный микрофон (Sonar): кабель не будет подхватываться и предлагаться</div></div>' + sw('s-cable-off', config.cableOff) + '</div>' +
    '</div>' +
    '<div class="set-group">' +
    '<div class="set-group-title">Эффекты</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Голосовой вызов</div>' +
    '<div class="set-desc">небольшой пик перед звуком — вас всегда слышно</div></div>' + sw('s-va', config.voiceActivation) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Автовыравнивание громкости</div>' +
    '<div class="set-desc">EBU R128: громкость всех треков выравнивается</div></div>' + sw('s-norm', config.normalize) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Приглушать музыку, когда я говорю</div>' +
    '<div class="set-desc">микрофон слышит голос — песня плавно затухает и возвращается, когда замолчишь</div></div>' + sw('s-duck', config.ducking !== false) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Сила приглушения</div>' +
    '<div class="set-desc">до какой громкости падает музыка во время речи</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" id="s-duck-level" min="5" max="90" value="' + Math.round((config.duckLevel != null ? config.duckLevel : 0.28) * 100) + '"><span class="volume" id="s-duck-level-out" style="width:46px">' + Math.round((config.duckLevel != null ? config.duckLevel : 0.28) * 100) + '%</span></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Автозапуск</div>' +
    '<div class="set-desc">запускать SoundPulse вместе с Windows</div></div>' + sw('s-login', config.openAtLogin) + '</div>' +
    '</div>' +
    '<div class="set-group">' +
    '<div class="set-group-title">Вид</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Размер кнопок</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" id="s-pad" min="70" max="140" value="' + Math.round(config.padScale * 100) + '"></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Размытие фона</div>' +
    '<div class="set-desc">мягкое размытие заднего плана за панелями</div></div>' + sw('s-blur', config.blur !== false) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Звуки интерфейса</div>' +
    '<div class="set-desc">тики и клики при наведении, нажатии, окнах</div></div>' + sw('s-ui-sounds', config.uiSounds) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Фон приложения</div></div>' +
    '<div class="set-ctrl"><button class="small-btn" id="s-bg-pick">Выбрать</button><button class="small-btn" id="s-bg-clear">Убрать</button></div></div>' +
    '<img id="s-bg-preview" style="display:none;width:100%;height:90px;object-fit:cover;border-radius:12px;border:1px solid rgba(255,255,255,.1);margin:4px 0 6px" />' +
    '<div class="set-desc" id="s-bg-name" style="margin:0 4px 6px">' + (config.background ? 'Фон задан' : 'Фона нет') + '</div>' +
    '</div>' +

    '<div class="set-group">' +
    '<div class="set-group-title">Горячие клавиши</div>' +
    '<div id="hk-list"></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Index-хоткеи</div>' +
    '<div class="set-desc">Ctrl+Alt+1..0 — звук по номеру</div></div>' + sw('s-idx', config.indexHotkeys) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Не перехватывать одиночные</div>' +
    '<div class="set-desc">одиночные клавиши проходят мимо SoundPulse</div></div>' + sw('s-pass', config.passHotkeys) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Одиночные клавиши глобально</div>' +
    '<div class="set-desc">работают даже на фоне, но блокируют эту букву везде</div></div>' + sw('s-single-global', config.singleKeysGlobal) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Одиночная клавиша после префикса</div>' +
    '<div class="set-desc">удерживай префикс 0.10 с, затем клавишу звука. Быстрый тап печатает сам символ</div></div>' + sw('s-prefix', config.prefixMode) + '</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Символ префикса</div>' +
    '<div class="set-desc">по умолчанию "\\" (справа от Ъ). Удержание 0.10 с включает режим, тап — обычный ввод</div></div>' +
    '<div class="set-ctrl"><input type="text" id="s-prefix-key" maxlength="1" style="width:56px;text-align:center" value="' + escapeHtml(config.prefixKey || '\\') + '"></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Клавиша войс-чата</div>' +
    '<div class="set-desc">удерживай префикс 0.10 с, затем букву (например T) — она зажмётся в игре; комбинация Ctrl/Shift/Alt+буква тоже работает</div></div>' +
    '<div class="set-ctrl"><input type="text" id="s-ptt" placeholder="T (жми «\\» затем T)" value="' + escapeHtml(String(config.pttKey || 'T')) + '"></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Горячие клавиши звуков</div>' +
    '<div class="set-desc">убрать все назначенные комбинации</div></div>' +
    '<div class="set-ctrl"><button class="small-btn" id="s-hk-reset">Сбросить все</button></div></div>' +
    '</div>' +
    '<div class="set-group">' +
    '<div class="set-group-title">Списки</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Список звуков</div>' +
    '<div class="set-desc">сохранить текущий набор или загрузить из файла</div></div>' +
    '<div class="set-ctrl"><button class="small-btn" id="s-list-exp">Экспорт (.json)</button><button class="small-btn" id="s-list-imp">Импорт</button></div></div>' +
    '</div>' +
    '<div class="set-group">' +
    '<div class="set-group-title">Проверка микрофона</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Уровень микрофона</div>' +
    '<div class="set-desc">прослушать пробный звук и посмотреть громкость</div></div>' +
    '<div class="set-ctrl"><button class="small-btn" id="s-mic-probe">' + ico('play') + 'Проверить</button><span class="volume" id="s-probe-out">0%</span></div></div>' +
    '<div id="s-probe-meter" class="hidden"></div>' +
    '</div>' +
    '<div class="set-group">' +
    '<div class="set-group-title">Мастер настройки</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Первый запуск</div>' +
    '<div class="set-desc">приветствие, установка VB-CABLE и подключение голосовой чат</div></div>' +
    '<div class="set-ctrl"><button class="small-btn" id="s-onboarding">Пройти заново</button></div></div>' +
    '</div>' +
    '<div class="hint">Windows не умеет подмешивать звук в обычный физический микрофон. Нужен виртуальный: ' +
    '<b>SteelSeries Sonar</b> (если установлен — качать ничего не надо), <b>VB-CABLE</b> или встроенный «Стерео микшер». ' +
    'SoundPulse может сам микшировать голос со звуками — включи «Голос в микрофон» и выбери виртуальный выход. ' +
    'Кнопка «Мастер» подберёт устройство и покажет, что выбрать в программе. F8 — остановить всё.</div>';

  openModal('Настройки', body,
    '<button class="small-btn" id="m-refresh">Обновить устройства</button><button class="small-btn" id="m-ok">Готово</button>');

const micBox = document.getElementById('dev-mic');
  const spkBox = document.getElementById('dev-spk');
  const micWarn = document.getElementById('mic-warn');
  const updateMicWarn = () => {
    if (!micWarn) return;
    const cur = config.outputDevice;
    const r = detectMicRoute();
    // показываем маршрут именно для выбранного устройства, а не «первое виртуальное»
    const sel = virtualRouteFor(cur);
    const route = sel || r;
    const sum = document.getElementById('mic-route-sum');
    if (!cur) {
      micWarn.textContent = 'Звук идёт в обычные динамики. Чтобы собеседник услышал, выбери виртуальный микрофон';
      micWarn.className = 'set-desc warn';
      if (sum) sum.textContent = r.mode === 'none' ? 'виртуальный микрофон не найден — открой мастер' : 'мастер переключит на ' + r.outLabel;
      return;
    }
    if (isVirtualMicLabel(deviceLabel(cur))) {
      micWarn.textContent = 'Виртуальный микрофон — в программе выбери «' + (route.discord || deviceLabel(cur)) + '»';
      micWarn.className = 'set-desc ok';
      if (sum) sum.textContent = 'готово: ' + deviceLabel(cur) + ' → программа';
    } else {
      micWarn.textContent = 'Это обычный выход (динамики/наушники). В микрофон звук не попадёт — открой «Мастер»';
      micWarn.className = 'set-desc warn';
      if (sum) sum.textContent = r.mode === 'none' ? 'виртуальный микрофон не найден' : 'сейчас: ' + deviceLabel(cur) + ' → нужно ' + r.outLabel;
    }
  };

  micBox.appendChild(deviceDropdown(micVal, 'mic', (id) => {
    config.outputDevice = id;
    if (id) config._noAutoMic = true; // явный выбор устройства: автоподбор его не перезапишет
    engine.setMicDevice(id);
    saveConfig();
    if (id) {
      toast('Микрофон: ' + deviceLabel(id), 'success');
      if (!isVirtualMicLabel(deviceLabel(id))) {
        toast('Это обычные динамики — в микрофон звук не попадёт. Открой «Мастер»', 'error');
      }
    }
    updateMicWarn();
  }));
  spkBox.appendChild(deviceDropdown(spkVal, 'spk', (id) => {
    config.speakerDevice = id;
    engine.setSpeakerDevice(id);
    saveConfig();
  }));
  updateMicWarn();
  const wizardBtn = document.getElementById('s-mic-wizard');
  if (wizardBtn) wizardBtn.addEventListener('click', (e) => { e.preventDefault(); micSetupModal(); });
  const obBtn = document.getElementById('s-onboarding');
  if (obBtn) obBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
    if (window.openOnboarding) window.openOnboarding();
  });

  // ---- голос: SoundPulse как виртуальный микрофон ----
  const voiceMicBox = document.getElementById('dev-voice-mic');
  if (voiceMicBox) {
    voiceMicBox.appendChild(deviceDropdown(config.voiceMicId || '', 'voice', async (id) => {
      config.voiceMicId = id;
      saveConfig();
      toast('Микрофон для голоса: ' + micLabel(id), 'success');
      if (config.voiceMix) {
        const ok = await applyVoiceMix();
        if (!ok) toast('Не удалось открыть микрофон для голоса', 'error');
      }
    }, (micInputs || []).map((d) => ({ id: d.id, label: d.label }))));
  }
  const sVoiceMix = document.getElementById('s-voice-mix');
  if (sVoiceMix) {
    sVoiceMix.addEventListener('change', async (e) => {
      config.voiceMix = e.target.checked;
      if (config.voiceMix) {
        // Кабель — лучший вариант: он ничего не добавляет от себя, поэтому голос
        // не задваивается. Sonar же подмешивает голос сам.
        const cable = !config.cableOff && (devices || []).find((d) => /cable/i.test(d.label) && /input/i.test(d.label));
        if (cable && config.outputDevice !== cable.id) {
          config.outputDevice = cable.id;
          config._noAutoMic = true;
          engine.setMicDevice(cable.id);
          toast('Выход для голоса: CABLE Input. В Steam или другой программе выбери микрофон CABLE Output', 'success');
        } else if (!cable && !(config.outputDevice && isVirtualMicLabel(deviceLabel(config.outputDevice)))) {
          // голос имеет смысл только через виртуальный микрофон — переключаем выход
          const r = detectMicRoute();
          if (r.mode !== 'none' && r.outId) {
            config.outputDevice = r.outId;
            config._noAutoMic = true;
            engine.setMicDevice(r.outId);
            toast('Выход для голоса: ' + r.outLabel, 'success');
          }
        }
      }
      saveConfig();
      if (config.voiceMix) {
        const ok = await applyVoiceMix();
        toast(ok
          ? 'Голос подмешивается: ' + micLabel(config.voiceMicId) + ' → ' + (deviceLabel(config.outputDevice) || 'система')
          : 'Не удалось открыть микрофон — проверь разрешение Windows', ok ? 'success' : 'error');
      } else {
        engine.stopVoice();
        toast('Микширование голоса выключено');
      }
    });
  }
  const voiceVol = document.getElementById('s-voice-vol');
  const voiceVolOut = document.getElementById('s-voice-vol-out');
  if (voiceVol) {
    engine.setVoiceVolume((config.voiceVolume != null ? config.voiceVolume : 100) / 100);
    voiceVol.addEventListener('input', () => {
      config.voiceVolume = +voiceVol.value;
      if (voiceVolOut) voiceVolOut.textContent = voiceVol.value + '%';
      engine.setVoiceVolume(config.voiceVolume / 100);
    });
    voiceVol.addEventListener('change', saveConfig);
  }
  const voiceGate = document.getElementById('s-voice-gate');
  const voiceGateOut = document.getElementById('s-voice-gate-out');
  if (voiceGate) {
    engine.setVoiceGate(((config.voiceGate != null ? config.voiceGate : 0) / 100) * 0.02);
    voiceGate.addEventListener('input', () => {
      config.voiceGate = +voiceGate.value;
      if (voiceGateOut) voiceGateOut.textContent = voiceGate.value + '%';
      engine.setVoiceGate((config.voiceGate / 100) * 0.02);
    });
    voiceGate.addEventListener('change', saveConfig);
  }
  const voiceMeter = document.getElementById('s-voice-meter');
  if (voiceMeter) {
    const bar = voiceMeter.querySelector('i');
    const meterTimer = setInterval(() => {
      if (!voiceMeter.isConnected) { clearInterval(meterTimer); return; }
      const lvl = engine.getVoiceLevel();
      const pct = Math.min(100, Math.sqrt(lvl) * 160);
      if (bar) bar.style.transform = 'scaleX(' + (pct / 100).toFixed(3) + ')';
    }, 80);
  }
  const cableOffEl = document.getElementById('s-cable-off');
  if (cableOffEl) {
    cableOffEl.addEventListener('change', async (e) => {
      config.cableOff = e.target.checked;
      saveConfig();
      toast(config.cableOff
        ? 'VB-CABLE отключён — используется Sonar или другой виртуальный микрофон'
        : 'VB-CABLE разрешён для автоподбора');
      // если сейчас писали в кабель, а его отключили — уводим звук на оставшийся маршрут
      if (config.cableOff && /cable/i.test(deviceLabel(config.outputDevice))) {
        const r = detectMicRoute();
        const id = r.mode !== 'none' ? r.outId : '';
        config.outputDevice = id;
        engine.setMicDevice(id);
        saveConfig();
        toast('Выход переключён: ' + (r.mode !== 'none' ? r.outLabel : 'системные динамики'));
      }
      await refreshDevices();
    });
  }

  const bgPreview = document.getElementById('s-bg-preview');
  if (config.background) { bgPreview.src = config.background; bgPreview.style.display = 'block'; }
  document.getElementById('s-va').addEventListener('change', (e) => {
    config.voiceActivation = e.target.checked;
    engine.setVoiceActivation(config.voiceActivation);
    saveConfig();
  });
  document.getElementById('s-norm').addEventListener('change', (e) => {
    config.normalize = e.target.checked;
    engine.setNormalize(config.normalize);
    saveConfig();
  });
  document.getElementById('s-duck').addEventListener('change', (e) => {
    setDucking(e.target.checked);
  });
  const duckLvl = document.getElementById('s-duck-level');
  duckLvl.addEventListener('input', (e) => {
    config.duckLevel = e.target.value / 100;
    document.getElementById('s-duck-level-out').textContent = e.target.value + '%';
    engine.setDuckAmount(config.duckLevel);
  });
  duckLvl.addEventListener('change', () => saveConfig());
  document.getElementById('s-login').addEventListener('change', (e) => {
    config.openAtLogin = e.target.checked;
    saveConfig();
    toast(config.openAtLogin ? 'Автозапуск включён' : 'Автозапуск выключен', 'success');
  });
  document.getElementById('s-pad').addEventListener('input', (e) => {
    config.padScale = e.target.value / 100;
    applyPad();
  });
  const blurSw = document.getElementById('s-blur');
  if (blurSw) blurSw.addEventListener('change', (e) => setBlur(e.target.checked));
  syncGlassModeUi();
  document.getElementById('s-bg-pick').addEventListener('click', async () => {
    const res = await api.pickImage();
    if (!res || !res.ok) {
      if (res && res.error) toast(res.error, 'error');
      return;
    }
    config.background = res.dataURL;
    applyBackground();
    bgPreview.src = config.background;
    bgPreview.style.display = 'block';
    document.getElementById('s-bg-name').textContent = 'Фон: ' + res.name;
    saveConfig();
  });
  document.getElementById('s-bg-clear').addEventListener('click', () => {
    config.background = '';
    applyBackground();
    bgPreview.style.display = 'none';
    document.getElementById('s-bg-name').textContent = 'Фона нет';
    saveConfig();
  });

  // --- спец-хоткеи ---
  const SPECIALS = [['stop', 'Стоп всё'], ['pause', 'Пауза / стоп'], ['random', 'Случайный звук'], ['next', 'Следующий звук'], ['prev', 'Предыдущий звук'], ['bass', 'Эффект: БАСЫ / ЖЕСТЬ / КНОПОЧНЫЙ / 425 БАЗА (цикл)'], ['volUp', 'Громче'], ['volDown', 'Тише'], ['mute', 'Mute']];
  const hkList = document.getElementById('hk-list');
  let capturing = null;
  function buildHkRows() {
    hkList.innerHTML = '';
    for (const [cmd, label] of SPECIALS) {
      const wrap = document.createElement('div');
      wrap.className = 'set-row';
      const lab = document.createElement('div');
      lab.className = 'set-label';
      const nm = document.createElement('div');
      nm.className = 'set-name';
      nm.textContent = label;
      lab.appendChild(nm);
      const ctrl = document.createElement('div');
      ctrl.className = 'set-ctrl';
      const b = document.createElement('button');
      b.className = 'small-btn';
      b.textContent = config.specialHotkeys[cmd] ? prettyHotkey(config.specialHotkeys[cmd]) : '—';
      b.textContent = b.textContent !== '—' ? b.textContent + ' (клик — сменить)' : 'Назначить';
      b.addEventListener('click', () => startHkCapture(cmd, b));
      ctrl.appendChild(b);
      wrap.appendChild(lab);
      wrap.appendChild(ctrl);
      hkList.appendChild(wrap);
    }
  }
  function startHkCapture(cmd, btn) {
    if (capturing) return;
    capturing = { cmd, btn, old: config.specialHotkeys[cmd] || null };
    btn.textContent = 'Нажмите клавишу... (Esc — отмена)';
    btn.classList.add('active');
    hkCaptureActive = true;
    api.suppressHotkeys(true);
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { endHkCapture(false); return; }
      if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      const key = keyFromEvent(e);
      if (!key) return;
      endHkCapture(true, [...mods, key].join('+'));
    };
    capturing.handler = handler;
    document.addEventListener('keydown', handler, true);
  }
  function endHkCapture(apply, accel) {
    const c = capturing;
    capturing = null;
    if (c && c.handler) document.removeEventListener('keydown', c.handler, true);
    if (hkCaptureActive) { hkCaptureActive = false; api.suppressHotkeys(false); }
    if (!c) return;
    c.btn.classList.remove('active');
    if (apply && accel) {
      const next = { ...config.specialHotkeys, [c.cmd]: accel };
      config.specialHotkeys = next;
      api.specialHotkeysSet(next);
      c.btn.textContent = prettyHotkey(accel) + ' (клик — сменить)';
      toast('Клавиша ' + prettyHotkey(accel) + ' назначена на «' + (SPECIALS.find((x) => x[0] === c.cmd) || [])[1] + '»', 'success');
    } else if (c.old) {
      c.btn.textContent = prettyHotkey(c.old) + ' (клик — сменить)';
    } else {
      c.btn.textContent = 'Назначить';
    }
    saveConfig();
  }
  buildHkRows();
  document.getElementById('s-idx').addEventListener('change', (e) => {
    config.indexHotkeys = e.target.checked;
    saveConfig();
    toast(e.target.checked ? 'Index-хоткеи включены (Ctrl+Alt+1..0)' : 'Index-хоткеи выключены');
  });
  document.getElementById('s-pass').addEventListener('change', (e) => {
    config.passHotkeys = e.target.checked;
    saveConfig();
    toast(e.target.checked ? 'Одиночные клавиши не перехватываются' : 'Одиночные клавиши перехватываются');
  });
  document.getElementById('s-single-global').addEventListener('change', (e) => {
    config.singleKeysGlobal = e.target.checked;
    saveConfig();
    api.settingsSet({ singleKeysGlobal: !!config.singleKeysGlobal }).catch(() => {});
    toast(e.target.checked
      ? 'Одинарные клавиши работают на фоне (буква будет блокироваться везде)'
      : 'Одинарные клавиши локальные — набор текста не блокируется');
  });
  document.getElementById('s-prefix').addEventListener('change', (e) => {
    config.prefixMode = e.target.checked;
    saveConfig();
    api.settingsSet({ prefixMode: !!config.prefixMode }).catch(() => {});
    toast(e.target.checked
      ? 'Режим префикса включён: удерживай "' + (config.prefixKey || '\\') + '" 0.10 с, затем клавишу'
      : 'Режим префикса выключен');
  });
  const sPrefixKey = document.getElementById('s-prefix-key');
  if (sPrefixKey) {
    sPrefixKey.addEventListener('change', (e) => {
      let v = (e.target.value || '').trim();
      v = v ? Array.from(v)[0] : '\\';
      e.target.value = v;
      config.prefixKey = v;
      saveConfig();
      api.settingsSet({ prefixKey: v }).catch(() => {});
      toast('Префикс: удерживай "' + v + '" 0.10 с, затем клавишу');
    });
  }
  const sPtt = document.getElementById('s-ptt');
  if (sPtt) {
    sPtt.addEventListener('change', (e) => {
      const v = (e.target.value || '').trim().toUpperCase().replace(/^\/\+/, '');
      e.target.value = v;
      config.pttKey = v;
      saveConfig();
      api.settingsSet({ pttKey: config.pttKey }).catch(() => {});
      toast('Войс-чат: «' + (config.pttKey || 'T') + '» — жми "\\" (справа от Ъ) затем эту клавишу: зажалась — говори, жми снова — отпустилась', 'success');
    });
  }
  document.getElementById('s-hk-reset').addEventListener('click', async () => {
    await api.resetHotkeys();
    config.specialHotkeys = { stop: 'F8' };
    config.sounds.forEach((s) => { s.hotkey = null; });
    hotkeyMap = {};
    buildHkRows();
    toast('Все горячие клавиши сброшены', 'success');
  });

  // --- списки ---
  document.getElementById('s-list-exp').addEventListener('click', async () => {
    const r = await api.listExport(config.sounds);
    if (r && r.ok) toast('Список сохранён', 'success');
    else toast('Экспорт отменён: ' + (r ? r.error : 'ошибка'), 'error');
  });
  document.getElementById('s-list-imp').addEventListener('click', async () => {
    const r = await api.listLoad();
    if (!r || !r.ok) { toast('Импорт отменён: ' + (r ? r.error : 'ошибка'), 'error'); return; }
    if (!Array.isArray(r.sounds) || !r.sounds.length) { toast('В файле нет звуков', 'error'); return; }
    for (const s of r.sounds) {
      if (!s || !s.path) continue;
      s.id = s.id || 's_' + randomId();
      if (s.volume == null) s.volume = 1;
      if (s.rate == null) s.rate = 1;
      if (s.mode == null) s.mode = 'mic';
      sounds.set(s.id, s);
    }
    config.sounds = r.sounds;
    for (const k of sounds.keys()) if (!config.sounds.some((s) => s.id === k)) sounds.delete(k);
    saveConfig();
    render();
    toast('Загружено звуков: ' + config.sounds.length, 'success');
  });

  // --- проверка микрофона с метром ---
  const probe = { stream: null, raf: 0, node: null, ctx: null };
  const probeBtn = document.getElementById('s-mic-probe');
  const probeOut = document.getElementById('s-probe-out');
  const meterWrap = document.getElementById('s-probe-meter');
  meterWrap.style.cssText = 'height:10px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:8px';
  const meterBar = document.createElement('div');
  meterBar.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#3ddc84,#ffd166,#ff5f6d);border-radius:6px;transition:none';
  meterWrap.appendChild(meterBar);
  stopMicProbe = function () {
    if (probe.raf) cancelAnimationFrame(probe.raf);
    probe.raf = 0;
    if (probe.node) { try { probe.node.disconnect(); } catch {} }
    if (probe.ctx) { try { probe.ctx.close(); } catch {} }
    if (probe.stream) probe.stream.getTracks().forEach((t) => t.stop());
    probe.stream = null; probe.node = null; probe.ctx = null;
    if (probeBtn) probeBtn.innerHTML = ico('play') + 'Проверить микрофон';
  };
  probeBtn.addEventListener('click', async () => {
    if (probe.stream) { stopMicProbe(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('worklet-recorder.js').catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      probe.stream = stream; probe.ctx = ctx; probe.node = analyser;
      probeBtn.innerHTML = ico('stop') + 'Стоп';
      const loop = () => {
        if (!probe.stream) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const pct = Math.min(100, (avg / 200) * 100);
        meterBar.style.width = pct.toFixed(0) + '%';
        probeOut.textContent = Math.round(pct) + '%';
        probe.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (err) {
      toast('Нет доступа к микрофону: ' + err.message, 'error');
    }
  });

  document.getElementById('m-refresh').addEventListener('click', async () => {
    toast('Обновляю устройства...');
    await refreshDevices();
    settingsModal();
  });
  document.getElementById('m-ok').addEventListener('click', () => {
    saveConfig();
    closeModal();
  });
}

// ---- мастер «Микрофон для голосовой чат»: подбирает виртуальный маршрут и проверяет его ----
function micSetupModal() {
  // Если пользователь уже выбрал виртуальное устройство — говорим про него,
  // а не про то, что «первым нашлось» (иначе CABLE в списке и Sonar в тексте).
  const auto = detectMicRoute();
  const sel = virtualRouteFor(config.outputDevice);
  const route = sel ? {
    ...auto,
    mode: sel.mode,
    outId: sel.outId,
    outLabel: sel.outLabel,
    inId: sel.inId,
    inLabel: sel.inLabel,
    discord: sel.discord,
    name: sel.mode === 'cable' ? 'VB-CABLE'
      : sel.mode === 'sonar' ? 'SteelSeries Sonar'
      : sel.mode === 'voicemeeter' ? 'VoiceMeeter'
      : (sel.outLabel || 'Виртуальный микрофон'),
    note: 'Выбрано: ' + sel.outLabel + '. В программе должен быть микрофон «' + sel.discord + '».',
    canTest: !!sel.inId
  } : auto;
  const hasRoute = route.mode !== 'none';
  const usingRoute = hasRoute && config.outputDevice === route.outId;

  const head = hasRoute
    ? '<div class="mic-route-head"><span class="mic-route-ico">' + ico('mic') + '</span><div>' +
      '<div class="mic-route-title">' + escapeHtml(route.name) + '</div>' +
      '<div class="set-desc">' + escapeHtml(route.note) + '</div></div></div>' +
      '<div class="mic-route-line">' +
      '<span class="mic-route-chip">SoundPulse</span><span class="mic-route-arrow">→</span>' +
      '<span class="mic-route-chip mid' + (usingRoute ? ' active' : '') + '" title="' + escapeHtml(route.outLabel) + '">' + escapeHtml(route.outLabel) + '</span>' +
      '<span class="mic-route-arrow">→</span><span class="mic-route-chip">голосовой чат</span></div>'
    : '<div class="mic-route-head"><span class="mic-route-ico warn">' + ico('mic') + '</span><div>' +
      '<div class="mic-route-title">Виртуальный микрофон не найден</div>' +
      '<div class="set-desc">Windows не позволяет приложению подмешивать звук в обычный физический микрофон — это ограничение системы, а не SoundPulse.</div></div></div>';

  const steps = hasRoute
    ? '<div class="set-group"><div class="set-group-title">Что сделать в программе</div>' +
      '<div class="mic-step"><b>1.</b><span>Открой настройки звука или голоса (в Steam — <b>Настройки → Голос</b>).</span></div>' +
      '<div class="mic-step"><b>2.</b><span>Микрофон (устройство ввода) → <span class="mic-dev-name">' + escapeHtml(route.discord) + '</span> <button class="small-btn" id="mr-copy">Копировать</button></span></div>' +
      '<div class="mic-step"><b>3.</b><span>Динамики (устройство вывода) → свои наушники или колонки, а не виртуальное устройство.</span></div>' +
      '<div class="mic-step"><b>4.</b><span>Если звук глухой — выключи шумоподавление и эхоподавление в настройках программы.</span></div>' +
      '</div>'
    : '<div class="set-group"><div class="set-group-title">Что можно сделать без установки</div>' +
      '<div class="mic-step"><b>1.</b><span><b>SteelSeries Sonar</b> — если есть наушники SteelSeries, запусти SteelSeries GG: виртуальный микрофон появится сам, качать ничего не нужно.</span></div>' +
      '<div class="mic-step"><b>2.</b><span><b>Стерео микшер</b> — включи его в «Параметры звука» Windows (Запись → Стерео микшер → Включить). Установка не нужна.</span></div>' +
      '<div class="mic-step"><b>3.</b><span><b>VB-CABLE</b> — если ничего выше нет, это единственный надёжный вариант (бесплатно, ставится за пару кликов). <button class="small-btn" id="mr-vb-get">' + 'Скачать' + '</button></span></div>' +
      '<div class="hint">Без виртуального устройства остаётся только «через воздух»: играть в динамики, а программа будет ловить звук микрофоном. Качество и эхо будут плохими.</div>' +
      '</div>';

  const testBlock = (hasRoute && route.canTest)
    ? '<div class="set-group"><div class="set-group-title">Проверка маршрута</div>' +
      '<div class="set-row" style="border:none"><div class="set-label"><div class="set-name">Тест виртуального микрофона</div>' +
      '<div class="set-desc">короткий сигнал пройдёт через SoundPulse и вернётся из микрофона — проверим весь путь</div></div>' +
      '<div class="set-ctrl"><button class="small-btn" id="mr-test">' + ico('play') + 'Проверить</button></div></div>' +
      '<div class="mic-test-meter" id="mr-meter"><i></i></div>' +
      '<div class="mic-route-result" id="mr-result"></div></div>'
    : '';

  const voiceStatus = config.voiceMix
    ? '<div class="set-group"><div class="set-group-title">Голос</div>' +
      '<div class="mic-step"><b>•</b><span>SoundPulse микширует голос сам: <b>' + escapeHtml(micLabel(config.voiceMicId)) + '</b> → ' + escapeHtml(deviceLabel(config.outputDevice) || 'система') + '</span></div>' +
      '<div class="mic-step"><b>•</b><span>Если голос уже даёт Sonar, выключи «SoundPulse микширует мой голос» в настройках — иначе он задвоится.</span></div></div>'
    : '';

  const cableReady = (devices || []).some((d) => /cable/i.test(d.label) && /input/i.test(d.label));
  const cableBlock = '<div class="set-group"><div class="set-group-title">VB-CABLE</div>' +
    '<div class="set-row" style="border:none"><div class="set-label">' +
    '<div class="set-name">' + (cableReady ? 'Установлен и готов' : 'Виртуальный кабель') + '</div>' +
    '<div class="set-desc">' + (cableReady
      ? 'CABLE Input / CABLE Output уже есть в системе. SoundPulse пишет в CABLE Input, игра читает CABLE Output.'
      : 'Открою официальный сайт VB-Audio — скачай пакет и запусти установщик.') + '</div></div>' +
    '<div class="set-ctrl">' + (cableReady ? '' : '<button class="small-btn" id="mr-vb-get">Скачать</button>') + '</div></div>' +
    '<div id="mr-vb-result" class="mic-route-result"></div></div>';

  const actions = '<button class="small-btn" id="mr-refresh">Обновить устройства</button>' +
    (hasRoute && !usingRoute ? '<button class="small-btn" id="mr-apply">Выбрать автоматически</button>' : '') +
    '<button class="small-btn" id="m-ok">Готово</button>';

  openModal('Микрофон для программы', head + voiceStatus + steps + testBlock + cableBlock, actions);

  document.getElementById('m-ok').addEventListener('click', () => { saveConfig(); closeModal(); });
  document.getElementById('mr-refresh').addEventListener('click', async () => {
    toast('Обновляю устройства...');
    await refreshDevices();
    micSetupModal();
  });

  const applyBtn = document.getElementById('mr-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => {
    config.outputDevice = route.outId;
    config._noAutoMic = true;
    engine.setMicDevice(route.outId);
    saveConfig();
    toast('Выбрано: ' + route.outLabel, 'success');
    micSetupModal();
  });

  const copyBtn = document.getElementById('mr-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(route.discord);
      toast('Скопировано: ' + route.discord, 'success');
    } catch {
      toast('Не удалось скопировать — выдели название вручную', 'error');
    }
  });

  const vbBtn = document.getElementById('mr-vb-get');
  if (vbBtn) vbBtn.addEventListener('click', () => {
    const out = document.getElementById('mr-vb-result');
    api.openExternal('https://vb-audio.com/Cable/').catch(() => {});
    if (out) {
      out.textContent = 'Открыл сайт VB-Audio. Скачай пакет, запусти установщик, нажми «Install Driver», затем «Обновить устройства».';
      out.className = 'mic-route-result';
    }
    toast('Открыл сайт VB-Audio — там кнопка Download');
  });

  const testBtn = document.getElementById('mr-test');
  if (testBtn) testBtn.addEventListener('click', () => runMicRouteTest(route, testBtn));
}

async function runMicRouteTest(route, btn) {
  const meterBox = document.getElementById('mr-meter');
  const meter = meterBox ? meterBox.querySelector('i') : null;
  const res = document.getElementById('mr-result');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stream = null;
  let capCtx = null;
  let osc = null;
  let gain = null;
  btn.disabled = true;
  btn.innerHTML = ico('stop') + 'Проверяю...';
  if (res) { res.textContent = ''; res.className = 'mic-route-result'; }
  if (meterBox) meterBox.style.display = 'block';
  if (meter) meter.style.transform = 'scaleX(0)';
  try {
    if (engine.mute || engine.masterVolume <= 0.001) {
      throw new Error('громкость в микрофон = 0%. Подними ползунок «Громкость» внизу.');
    }
    // маршрут должен быть выбран до теста
    if (config.outputDevice !== route.outId) {
      config.outputDevice = route.outId;
      saveConfig();
    }
    // ждём, пока AudioContext реально переключится на виртуальный выход,
    // иначе первые полсекунды сигнал уйдёт в старые динамики
    await engine.setMicDevice(route.outId);
    engine.ensure();
    const chain = engine.micCtx;
    if (!chain) throw new Error('аудиоустройство недоступно');
    if (chain.ctx.state === 'suspended') await chain.ctx.resume().catch(() => {});

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: route.inId ? { exact: route.inId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    capCtx = new AudioContext();
    if (capCtx.state === 'suspended') await capCtx.resume().catch(() => {});
    const src = capCtx.createMediaStreamSource(stream);
    const an = capCtx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const data = new Float32Array(an.fftSize);
    const read = () => {
      an.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / data.length);
    };

    osc = chain.ctx.createOscillator();
    gain = chain.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.value = 0.5;
    osc.connect(gain);
    gain.connect(chain.master);

    // фон (шум комнаты) — чтобы не спутать его с сигналом
    let noise = 0;
    let t0 = performance.now();
    while (performance.now() - t0 < 350) {
      const v = read();
      if (v > noise) noise = v;
      await sleep(40);
    }
    osc.start();
    let peak = 0;
    t0 = performance.now();
    while (performance.now() - t0 < 850) {
      const v = read();
      if (v > peak) peak = v;
      if (meter) meter.style.transform = 'scaleX(' + Math.min(1, v * 16).toFixed(3) + ')';
      await sleep(40);
    }
    const ok = peak > 0.0025 && peak > Math.max(0.0015, noise * 2.2);
    if (res) {
      res.className = 'mic-route-result ' + (ok ? 'ok' : 'err');
      res.textContent = ok
        ? 'Маршрут работает: звук доходит до «' + route.inLabel + '». В программе выбери этот же микрофон.'
        : 'Звук не вернулся. Проверь, что «' + route.inLabel + '» включён и в программе выбран именно он.';
    }
  } catch (e) {
    if (res) {
      res.className = 'mic-route-result err';
      res.textContent = 'Не удалось проверить: ' + (e && e.message ? e.message : e);
    }
  } finally {
    if (osc) { try { osc.stop(); } catch {} }
    if (stream) stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    if (capCtx) { try { await capCtx.close(); } catch {} }
    if (meterBox) meterBox.style.display = 'none';
    btn.disabled = false;
    btn.innerHTML = ico('play') + 'Проверить';
  }
}

function applyPad() {
  render();
}

function applyBackground() {
  const base = 'radial-gradient(circle at 78% 55%,rgba(92,45,164,.27),transparent 27%),radial-gradient(circle at 83% 72%,rgba(26,142,133,.18),transparent 25%),linear-gradient(135deg,#111a2c 0%,#070a10 55%,#080b12 100%)';
  const layer = document.getElementById('bg-layer');
  if (config.background) {
    const dim = Math.max(0, Math.min(95, config.bgDim != null ? config.bgDim : 78)) / 100;
    if (layer) {
      layer.style.backgroundImage = 'linear-gradient(rgba(8,11,18,' + dim + '),rgba(8,11,18,' + dim + ')),url("' + config.background + '")';
    }
    document.body.style.background = base;
  } else {
    if (layer) layer.style.backgroundImage = 'none';
    document.body.style.background = '';
  }
}

// ---- кастомизация вида: акцент, радиус, размер карточек, анимации, aurora ----
function applyAppearance() {
  const root = document.documentElement;
  root.style.setProperty('--accent', config.accent || '#55a9ff');
  root.style.setProperty('--radius', (config.radius != null ? config.radius : 22) + 'px');
  root.style.setProperty('--card-scale', String(config.cardScale || 1));
  root.style.setProperty('--anim', String(config.animSpeed || 1));
  document.body.classList.toggle('no-anim', config.anims === false);
  document.body.classList.toggle('no-aurora', config.aurora === false);
  document.body.classList.toggle('no-tilt', config.tilt === false);
}

// настройки вида меняются в отдельном окне — применяем на лету
function watchAppearance() {
  if (!api.onSettingsChanged) return;
  api.onSettingsChanged((s) => {
    if (!s) return;
    let changed = false;
    let scaleChanged = false;
    for (const k of ['accent', 'radius', 'cardScale', 'bgDim', 'aurora', 'anims', 'animSpeed', 'tilt', 'blur', 'background']) {
      if (s[k] === undefined) continue;
      if (config[k] !== s[k]) {
        if (k === 'cardScale') scaleChanged = true;
        config[k] = s[k];
        changed = true;
      }
    }
    if (!changed) return;
    applyAppearance();
    applyBackground();
    applyBlur();
    updateBlurUi();
    if (scaleChanged) render(); // размер карточек задаётся при отрисовке
    if (!config.anims) {
      document.querySelectorAll('.sound').forEach((el) => {
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
    }
  });
}

// ---- материал интерфейса: обычное размытие фона (жидкое стекло удалено) ----
const GLASS_MODES = ['blur', 'off'];
function normGlassMode(m) {
  return m === 'off' ? 'off' : 'blur';
}

function applyBlur() {
  const on = config.blur !== false;
  config.glassMode = on ? 'blur' : 'off';
  document.body.classList.toggle('no-blur', !on);
  document.body.classList.toggle('glass-liquid', false);
  document.body.classList.toggle('glass-blur', on);
}

function syncGlassModeUi() {}

function updateBlurUi() {
  const btn = document.getElementById('btn-blur');
  if (btn) {
    const off = config.blur === false;
    btn.classList.toggle('off', off);
    btn.title = off ? 'Размытие выключено — нажми, чтобы включить' : 'Размытие включено — нажми, чтобы выключить';
  }
}

function setBlur(on) {
  config.blur = !!on;
  applyBlur();
  updateBlurUi();
  saveConfig();
  toast(config.blur ? 'Размытие включено' : 'Размытие выключено');
}

function setGlassMode(mode) {
  setBlur(normGlassMode(mode) !== 'off');
}

// ---- дакинг: говоришь — музыка тише, замолчал — вернулась ----
function setDucking(on) {
  config.ducking = !!on;
  engine.setDucking(config.ducking);
  saveConfig();
  toast(config.ducking
    ? 'Дакинг включён: музыка приглушается, когда говоришь'
    : 'Дакинг выключен');
  const s = document.getElementById('s-duck');
  if (s) s.checked = config.ducking;
}

// ---------- test modal ----------

function testModal() {
  const opts = config.sounds.map((s, i) => '<option value="' + s.id + '"' + (i === 0 ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>').join('');
  const body =
    '<div class="set-group">' +
    '<div class="set-desc" style="margin:2px 4px 6px;font-size:12px">Проверь, как будет слышно — звук идёт по тем же путям, что и в микрофон</div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Звук</div></div>' +
    '<div class="set-ctrl"><select id="test-sound">' + opts + '</select></div></div>' +
    '<div class="set-row"><div class="set-label"><div class="set-name">Скорость</div></div>' +
    '<div class="set-ctrl"><input class="range" type="range" id="test-rate" min="50" max="200" value="100"><span class="volume" id="test-rate-out" style="width:52px">100%</span></div></div>' +
    '</div>';
  openModal('Тест', body,
    '<button class="small-btn" id="m-stop">' + ico('stop') + 'Стоп</button><button class="small-btn" id="m-play">' + ico('play') + 'Играть</button><button class="small-btn" id="m-close">Закрыть</button>');

  const rate = document.getElementById('test-rate');
  const rateOut = document.getElementById('test-rate-out');
  rate.addEventListener('input', () => { rateOut.textContent = rate.value + '%'; });

  const play = () => {
    const sel = document.getElementById('test-sound');
    playSound(sel.value, { rate: rate.value / 100 });
  };
  document.getElementById('test-rate').value = String(Math.round(testRate * 100));
  rateOut.textContent = testRate * 100 + '%';
  document.getElementById('m-play').addEventListener('click', play);
  document.getElementById('m-stop').addEventListener('click', stopAll);
  document.getElementById('m-close').addEventListener('click', closeModal);
}

// ---------- import (internet) modal ----------

function importModal() {
  openModal('Импорт из интернета',
    '<div class="set-group"><div class="set-row"><div class="set-label"><div class="set-name">Ссылка на аудиофайл</div>' +
    '<div class="set-desc">.mp3, .wav, .ogg ... — прямая ссылка на файл</div></div></div>' +
    '<div class="set-row" style="border:none;padding-top:0"><input type="url" id="import-url" placeholder="https://example.com/sound.mp3" /></div></div>' +
    '<div class="hint">Кнопки «Поделиться» у файла в облаке/на сайте &gt; «Скопировать ссылку». YouTube и плейлисты не поддерживаются — качается сам файл.</div>',
    '<button class="small-btn" id="m-go">' + ico('download') + 'Скачать</button><button class="small-btn" id="m-cancel">Отмена</button>');
  const url = document.getElementById('import-url');
  url.focus();
  const goBtn = document.getElementById('m-go');
  const doImport = async () => {
    const u = url.value.trim();
    if (!u) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Скачиваю...';
    const res = await api.webDownload(u);
    if (res.ok) {
      await addSoundFiles([{ name: res.name, path: res.path }]);
      closeModal();
    } else {
      toast('Не удалось скачать: ' + (res.error || 'ошибка'), 'error');
      goBtn.disabled = false;
      goBtn.innerHTML = ico('download') + 'Скачать';
    }
  };
  goBtn.addEventListener('click', doImport);
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
  document.getElementById('m-cancel').addEventListener('click', closeModal);
}

// ---------- history modal ----------

function historyModal() {
  const anyPlays = config.sounds.some((s) => (s.plays || 0) > 0);
  if (!history.length) {
    openModal('История',
      '<div class="set-group"><div class="set-desc" style="margin:2px 4px 6px">Пока пусто — сыграйте пару звуков.</div></div>',
      (anyPlays ? '<button class="small-btn" id="m-reset-count">Сбросить счётчик</button>' : '') + '<button class="small-btn" id="m-close">Закрыть</button>');
    const rc = document.getElementById('m-reset-count');
    if (rc) rc.addEventListener('click', () => { resetPlayCounts(); closeModal(); });
    document.getElementById('m-close').addEventListener('click', closeModal);
    return;
  }
  const rows = history.map((h, i) => {
    const t = new Date(h.time);
    const pad = (n) => String(n).padStart(2, '0');
    return '<div class="hist-item" data-id="' + h.id + '" style="--si:' + i + '">' +
      '<span class="hist-name">' + escapeHtml(h.name) + '</span>' +
      '<span class="hist-time">' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + '</span></div>';
  }).join('');
  openModal('История (последние ' + history.length + ')',
    '<div id="hist-list" style="max-height:340px;overflow:auto">' + rows + '</div>',
    '<button class="small-btn" id="m-clear">Очистить историю</button><button class="small-btn" id="m-reset-count">Сбросить счётчик</button><button class="small-btn" id="m-close">Закрыть</button>');
  document.getElementById('hist-list').addEventListener('click', (e) => {
    const it = e.target.closest('.hist-item');
    if (it) playSound(it.dataset.id);
  });
  document.getElementById('m-clear').addEventListener('click', () => { history = []; closeModal(); });
  document.getElementById('m-reset-count').addEventListener('click', () => { resetPlayCounts(); closeModal(); });
  document.getElementById('m-close').addEventListener('click', closeModal);
}

function resetPlayCounts() {
  for (const s of config.sounds) s.plays = 0;
  history = [];
  saveConfig();
  render();
  toast('Счётчик «Проиграно» сброшен в 0', 'success');
}

// ---------- recording ----------

let rec = { ctx: null, src: null, node: null, stream: null, chunks: [], timer: null };

function recorderCleanup() {
  stopRecording();
  clearInterval(rec.timer);
  rec.timer = null;
}

function stopRecording() {
  if (rec.node) { try { rec.node.port.close(); } catch {} try { rec.node.disconnect(); } catch {} }
  if (rec.src) { try { rec.src.disconnect(); } catch {} }
  if (rec.ctx) { try { rec.ctx.close(); } catch {} }
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec = { ctx: null, src: null, node: null, stream: null, chunks: [], timer: null };
}

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

function recordModal() {
  openModal('Запись в микрофон',
    '<div class="set-group"><div class="set-row" style="justify-content:center;border:none;gap:12px"><span class="rec-dot" id="rec-dot"></span><span class="rec-time" id="rec-time">00:00</span></div>' +
    '<div class="set-desc" style="text-align:center;margin:0 4px 6px">Зазвучит ваш микрофон — запишите что-нибудь</div></div>',
    '<button class="small-btn" id="m-record">' + ico('record') + 'Начать</button><button class="small-btn" id="m-cancel">Отмена</button>');

  const timeEl = document.getElementById('rec-time');
  const dot = document.getElementById('rec-dot');
  const btn = document.getElementById('m-record');

  const setTimer = () => {
    const sec = Math.floor((Date.now() - rec.start) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    timeEl.textContent = pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
  };

  btn.addEventListener('click', async () => {
    if (rec.node) { await finalizeRecording(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule('worklet-recorder.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'recorder-processor');
      node.port.onmessage = (e) => { if (e.data && e.data.length) rec.chunks.push(new Float32Array(e.data)); };
      src.connect(node);
      rec = { ctx, src, node, stream, chunks: [], start: Date.now(), timer: null };
      setTimer();
      rec.timer = setInterval(setTimer, 250);
      dot.style.animation = '';
      btn.innerHTML = ico('stop') + 'Стоп';
    } catch (err) {
      toast('Нет доступа к микрофону: ' + err.message, 'error');
    }
  });
  document.getElementById('m-cancel').addEventListener('click', closeModal);

  async function finalizeRecording() {
    const chunks = rec.chunks;
    const timer = rec.timer;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    stopRecording();
    clearInterval(timer);
    setTimeout(() => { dot.style.animation = 'none'; btn.innerHTML = ico('record') + 'Начать'; }, 0);
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = 'Запись ' + ts.getFullYear() + '-' + pad(ts.getMonth() + 1) + '-' + pad(ts.getDate()) + ' ' + pad(ts.getHours()) + '-' + pad(ts.getMinutes());
    try {
      const buf = encodeWav(all, 48000);
      const res = await api.recordingSave(buf, name);
      if (res.ok) {
        await addSoundFiles([{ name, path: res.path }]);
        toast('Запись сохранена', 'success');
      } else {
        toast('Ошибка сохранения: ' + (res.error || ''), 'error');
      }
    } catch (err) {
      toast('Ошибка сохранения: ' + err.message, 'error');
    }
  }
}

// ---------------- toasts ----------------

function toast(message, kind) {
  if (kind === 'error') uiSound('error');
  else if (kind === 'success') uiSound('success');
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 230);
  }, 3800);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// inline-иконка из спрайта в index.html
function ico(name) {
  return '<svg class="ic"><use href="#i-' + name + '"/></svg>';
}

// ---------------- config persistence ----------------

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const patch = {
      masterVolume: config.masterVolume,
      monitor: config.monitor,
      monitorVol: config.monitorVol,
      micEnabled: config.micEnabled,
      overlapMode: config.overlap ? 'overlap' : 'stop',
      allMode: !!config.all,
      fartLevel: config.bass,
      mute: config.mute,
      selfOff: !!config.selfOff,
      outputDeviceId: config.outputDevice,
      speakerDeviceId: config.speakerDevice,
      voiceMix: !!config.voiceMix,
      voiceMicId: config.voiceMicId || '',
      voiceVolume: config.voiceVolume != null ? config.voiceVolume : 100,
      voiceGate: config.voiceGate != null ? config.voiceGate : 0,
      cableOff: !!config.cableOff,
      cableRouteDone: !!config.cableRouteDone,
      normalize: !!config.normalize,
      voiceActivation: !!config.voiceActivation,
      ducking: config.ducking !== false,
      duckLevel: config.duckLevel != null ? config.duckLevel : 0.28,
      openAtLogin: !!config.openAtLogin,
      padScale: config.padScale || 1,
      background: config.background || '',
      blur: config.blur !== false,
      glassMode: normGlassMode(config.glassMode),
      glassModePrev: normGlassMode(config.glassModePrev || config.glassMode || 'blur'),
      indexHotkeys: !!config.indexHotkeys,
      passHotkeys: !!config.passHotkeys,
      singleKeysGlobal: !!config.singleKeysGlobal,
      prefixMode: !!config.prefixMode,
      prefixKey: config.prefixKey || '\\',
      uiSounds: !!config.uiSounds,
pttKey: String(config.pttKey || 'Ctrl+Shift+T'),
      autoNext: !!config.autoNext,
      shuffle: !!config.shuffle,
      loopOne: !!config.loopOne,
      accent: config.accent || '#55a9ff',
      radius: config.radius != null ? config.radius : 22,
      cardScale: config.cardScale || 1,
      bgDim: config.bgDim != null ? config.bgDim : 78,
      aurora: config.aurora !== false,
      anims: config.anims !== false,
      animSpeed: config.animSpeed || 1,
      tilt: config.tilt !== false,
      categories: config.categories.map((c) => ({ id: c.id, name: c.name })),
      onboarded: !!config.onboarded,
      tourDone: !!config.tourDone,
      onboardingRev: +config.onboardingRev || 0,
      resume: resumeState
    };
    api.settingsSet(patch).catch(() => {});
    api.librarySave({ sounds: config.sounds.map(({ _handle, _startMs, _len, playing, missing, ...rest }) => rest) }).catch(() => {});
  }, 250);
}

// ---------------- hotkey commands ----------------

function changeMaster(delta) {
  config.masterVolume = Math.max(0, Math.min(1, config.masterVolume + delta));
  engine.setVolume(config.masterVolume);
  const r = document.getElementById('r-master');
  const v = document.getElementById('v-master');
  if (r && v) { r.value = Math.round(config.masterVolume * 100); v.textContent = r.value + '%'; paintRange(r); }
  saveConfig();
}

// Служебный запуск (Random / перелистывание): новый звук глушит предыдущий,
// иначе быстрое нажатие наворачивает до 5 песен одновременно
function playCmd(id) {
  if (cmdSoundId && cmdSoundId !== id) {
    const prev = sounds.get(cmdSoundId);
    // стоп БЕЗ проверки playing: при быстрых нажатиях предыдущий запуск ещё
    // грузится (async) и s.playing ещё false — глушим всегда, токен прервёт
    // незавершённый запуск, engine.stop гасит живую группу
    if (prev) stopSound(prev, true);
  }
  cmdSoundId = id;
  playSound(id);
}

function playRandom() {
  const list = visibleSounds();
  if (!list.length) { toast('Нет звуков', 'error'); return; }
  playCmd(list[Math.floor(Math.random() * list.length)].id);
}

// ---- автоследующая: песня естественно закончилась -> играется следующая ----
// Короткие эффекты (<5с) очередь не тянут, чтобы саундпад-семплы не каскадились.
const AUTO_NEXT_MIN = 1.5; // сек
function maybeAutoNext(prev) {
  if (!config.autoNext) return;
  if (!prev || !prev._len || prev._len < AUTO_NEXT_MIN) return;
  // юзер уже вмешался вручную — не влазим
  if (config.sounds.some((x) => x.playing)) return;
  const list = visibleSounds();
  if (!list.length) return;
  let next;
  if (config.shuffle) {
    const pool = list.filter((x) => x.id !== prev.id);
    next = pool.length ? pool[Math.floor(Math.random() * pool.length)] : list[0];
  } else {
    const idx = list.findIndex((x) => x.id === prev.id);
    next = list[idx >= 0 ? (idx + 1) % list.length : 0];
  }
  if (!next || next.id === prev.id) return;
  setTimeout(() => {
    if (config.sounds.some((x) => x.playing)) return;
    playCmd(next.id);
    toast('Следующая: ' + next.name, 'success');
  }, 200);
}

function curPosOf(s) {
  if (!s) return 0;
  const elapsed = (performance.now() - (s._startMs || 0)) / 1000;
  let pos = Math.max(0, (s._startOffset || 0) + elapsed * (s._rate || 1));
  if (s._heldLoop && s._len > 0) pos = pos % s._len;
  return pos;
}

// «Зациклить»: следующая смена текущей песни повторяет её бесконечно
function toggleLoop() {
  config.loopOne = !config.loopOne;
  const playing = config.sounds.filter((x) => x.playing);
  if (playing.length) {
    const s = playing[playing.length - 1];
    const pos = curPosOf(s);
    stopSound(s, true);
    playSound(s.id, { offset: pos, loop: config.loopOne });
  }
  updatePlaybar();
  saveConfig();
  toast(config.loopOne ? 'Зациклено: следующая смена песни — по кругу' : 'Зацикливание выключено');
}

function toggleShuffle() {
  config.shuffle = !config.shuffle;
  updatePlaybar();
  saveConfig();
  toast(config.shuffle ? 'Вперемешку: играем не по порядку' : 'По порядку: автоследующая идёт по списку');
}

let seekDragging = false;

function seekToPlay(pct) {
  const playing = config.sounds.filter((x) => x.playing);
  if (!playing.length) {
    // тишина: двигали ползунок — следующий «Плей» стартует с выбранного места
    if (!resumeState && stoppedId) {
      const st = sounds.get(stoppedId);
      if (st) resumeState = { id: st.id, pos: 0, ts: Date.now() };
    }
    if (resumeState) {
      const st = sounds.get(resumeState.id);
      if (!st) { resumeState = null; return; }
      const len = st._len || 0;
      resumeState.pos = len > 0 ? Math.max(0, Math.min(len - 0.02, (pct / 1000) * len)) : 0;
      saveConfig();
    }
    return;
  }
  const s = playing[playing.length - 1];
  if (!s || !s._len) return;
  const pos = Math.max(0, Math.min(s._len - 0.02, (pct / 1000) * s._len));
  stopSound(s, true);
  playSound(s.id, { offset: pos });
}

function playFirstAvailable() {
  const list = visibleSounds();
  if (!list.length) { toast('Нет звуков для воспроизведения', 'error'); return; }
  playSound(list[0].id);
}

// «Пауза / воспроизведение»: если играет — пауза с запоминанием трека и позиции;
// если тишина — возобновляем запомненное (даже после перезапуска), иначе первый трек
function pauseToggle() {
  const playing = config.sounds.filter((s) => s.playing);
  if (playing.length) {
    const s = playing[playing.length - 1];
    const elapsed = (performance.now() - (s._startMs || 0)) / 1000;
    let pos = Math.max(0, (s._startOffset || 0) + elapsed * (s._rate || 1));
    if (s._len > 0) pos = Math.min(pos, s._len);
    resumeState = { id: s.id, pos, ts: Date.now() };
    stopAll();
    saveConfig();
    toast('Пауза: ' + s.name);
    return;
  }
  if (resumeState && resumeState.id) {
    const s = sounds.get(resumeState.id);
    if (s) {
      playSound(s.id, { offset: resumeState.pos });
      toast('Возобновлено: ' + s.name);
      return;
    }
    resumeState = null;
    saveConfig();
  }
  playFirstAvailable();
}

function runCmd(cmd) {
  switch (cmd) {
case 'stop':
      stopAll();
      saveConfig();
      break;
    case 'pause': pauseToggle(); break;
    case 'random': playRandom(); break;
case 'next': {
      const list = visibleSounds();
      if (!list.length) break;
      const cur = list.findIndex((x) => x.playing);
      if (config.shuffle) {
        const pool = list.filter((_, i) => i !== cur);
        if (pool.length) {
          const pick = pool[Math.floor(Math.random() * pool.length)];
          if (pick) { playCmd(pick.id); break; }
        }
      }
      playCmd(list[cur >= 0 ? (cur + 1) % list.length : 0].id);
      break;
    }
    case 'prev': {
      const list = visibleSounds();
      if (list.length) {
        const cur = list.findIndex((x) => x.playing);
        playCmd(list[cur >= 0 ? (cur - 1 + list.length) % list.length : list.length - 1].id);
      }
      break;
    }
    case 'volUp': changeMaster(0.05); break;
    case 'volDown': changeMaster(-0.05); break;
    case 'bass': document.getElementById('f-bass').click(); break;
    case 'mute': document.getElementById('f-mute').click(); break;
  }
}

// одинарные буквы/цифры — локальные хоткеи: срабатывают только пока окно в фокусе,
// чтобы не блокировать набор текста в других программах.
function isLocalOnly(accel) {
  if (!accel || accel.includes('+')) return false;
  if (/^F\d{1,2}$/.test(accel)) return false;
  if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'PrintScreen', 'Up', 'Down', 'Left', 'Right'].includes(accel)) return false;
  return true;
}

function localHotkeyHandler(e) {
  if (hkCaptureActive) return;
  // В режиме префикса одиночная клавиша не срабатывает сама никогда:
  // ни глобально, ни в окне приложения. Только после удержания префикса.
  if (config.prefixMode) return;
  if (config.singleKeysGlobal) return; // одиночные клавиши уже глобальные — main сам обработает
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = keyFromEvent(e);
  if (!key) return;
  const accel = [...mods, key].join('+');
  if (!isLocalOnly(accel)) return;
  for (const s of config.sounds) {
    if (s.hotkey === accel) { e.preventDefault(); playSound(s.id); return; }
  }
  for (const cmd of Object.keys(config.specialHotkeys)) {
    if (config.specialHotkeys[cmd] === accel) { e.preventDefault(); runCmd(cmd); return; }
  }
}

// ---------------- wiring ----------------

let pendingHotkey = null;
let hkCaptureActive = false; // идёт захват клавиши -> глобальные хоткеи временно глушим

function bindUI() {
  // window controls
  document.getElementById('win-min').addEventListener('click', () => winAnimate(() => api.windowControls.minimize()));
  document.getElementById('win-max').addEventListener('click', () => api.windowControls.toggleMaximize());
  document.getElementById('win-close').addEventListener('click', () => api.windowControls.close());
  api.windowControls.onCloseRequested(closeRequestedModal);

  // header
  document.getElementById('btn-settings').addEventListener('click', settingsModal);
  const btnCustom = document.getElementById('btn-customize');
  if (btnCustom) btnCustom.addEventListener('click', customizeModal);

  // sidebar
  document.getElementById('btn-add-sound').addEventListener('click', pickAndAdd);
  document.getElementById('btn-add-folder').addEventListener('click', pickFolder);
  document.getElementById('btn-new-set').addEventListener('click', addCategory);
  document.getElementById('btn-record').addEventListener('click', recordModal);
  document.getElementById('btn-open-recordings').addEventListener('click', () => {
    api.documentsOpen('recordings').then((r) => {
      if (r && !r.ok) toast('Не удалось открыть записи: ' + r.error, 'error');
    });
  });
  document.getElementById('btn-open-downloads').addEventListener('click', () => {
    api.documentsOpen('downloads').then((r) => {
      if (r && !r.ok) toast('Не удалось открыть загрузки: ' + r.error, 'error');
    });
  });

// now bar
  document.getElementById('btn-random').addEventListener('click', playRandom);
  document.getElementById('btn-history').addEventListener('click', historyModal);
  document.getElementById('btn-prev').addEventListener('click', () => runCmd('prev'));
  document.getElementById('btn-next').addEventListener('click', () => runCmd('next'));
  document.getElementById('btn-playpause').addEventListener('click', pauseToggle);
  document.getElementById('btn-loop').addEventListener('click', toggleLoop);
  document.getElementById('btn-shuffle').addEventListener('click', toggleShuffle);
  document.getElementById('btn-auto').addEventListener('click', () => {
    config.autoNext = !config.autoNext;
    updatePlaybar();
    saveConfig();
    toast(config.autoNext ? 'Автоследующая включена' : 'Автоследующая выключена');
  });
  const seekBar = document.getElementById('seek-bar');
  paintRange(seekBar);
  seekBar.addEventListener('input', () => paintRange(seekBar));
  seekBar.addEventListener('pointerdown', () => { seekDragging = true; });
  seekBar.addEventListener('pointerup', () => {
    seekDragging = false;
    seekToPlay(+seekBar.value);
  });
  seekBar.addEventListener('change', () => {
    if (seekDragging) { seekDragging = false; seekToPlay(+seekBar.value); }
  });
  let seekTapT = 0;
  seekBar.addEventListener('keyup', () => {
    const now = Date.now();
    if (now - seekTapT > 200) return;
    seekTapT = now;
    seekToPlay(+seekBar.value);
  });

  // footer
  document.getElementById('f-mic').addEventListener('click', () => {
    config.micEnabled = !config.micEnabled;
    if (!config.micEnabled) stopAll(); // выключили микрофон — гасим всё, что играет в него
    renderFooterButtons();
    saveConfig();
    toast(config.micEnabled ? 'Микрофон включён' : 'Микрофон выключен — звук в микрофон больше не идёт', 'success');
  });
  document.getElementById('f-overlap').addEventListener('click', () => {
    config.overlap = !config.overlap;
    renderFooterButtons();
    saveConfig();
    toast(config.overlap ? 'Внахлёст: звуки могут накладываться' : 'Внахлёст выключен');
  });
  document.getElementById('f-bass').addEventListener('click', () => {
    // 0 обычный -> 1 БАСЫ -> 2 ЖЕСТЬ -> 3 КНОПОЧНЫЙ -> 4 425 БАЗА -> 0
    config.bass = (config.bass + 1) % 5;
    renderBassButton();
    engine.setFart(config.bass);
    saveConfig();
  });
  document.getElementById('f-all').addEventListener('click', () => {
    config.all = !config.all;
    renderFooterButtons();
    saveConfig();
    toast(config.all ? '«Всем»: каждый звук идёт и в микрофон, и в динамики' : '«Всем» выключен: учитывается режим каждого звука');
  });
  document.getElementById('f-nothear').addEventListener('click', () => {
    config.selfOff = !config.selfOff;
    renderFooterButtons();
    engine.setSelfOff(config.selfOff);
    saveConfig();
    toast(config.selfOff ? 'Себя не слышно: колонки заглушены (микрофон работает)' : 'Слышишь себя снова');
  });
  document.getElementById('f-mute').addEventListener('click', () => {
    config.mute = !config.mute;
    renderFooterButtons();
engine.setMute(config.mute);
  engine.setSelfOff(config.selfOff);
    saveConfig();
  });
  document.getElementById('f-stop').addEventListener('click', stopAll);
  document.getElementById('f-test').addEventListener('click', testModal);

  // volume sliders
  const rMaster = document.getElementById('r-master');
  const vMaster = document.getElementById('v-master');
  const rMonitor = document.getElementById('r-monitor');
  const vMonitor = document.getElementById('v-monitor');
  rMaster.value = Math.round(config.masterVolume * 100);
  vMaster.textContent = rMaster.value + '%';
  paintRange(rMaster);
  rMonitor.value = Math.round(config.monitorVol * 100);
  if (vMonitor) vMonitor.textContent = rMonitor.value + '%';
  paintRange(rMonitor);
  rMaster.addEventListener('input', () => {
    config.masterVolume = rMaster.value / 100;
    vMaster.textContent = rMaster.value + '%';
    paintRange(rMaster);
    engine.setVolume(config.masterVolume);
    saveConfig();
  });
  rMonitor.addEventListener('input', () => {
    config.monitorVol = rMonitor.value / 100;
    if (vMonitor) vMonitor.textContent = rMonitor.value + '%';
    paintRange(rMonitor);
    engine.setMonitorVol(config.monitorVol);
    saveConfig();
  });

  // низ сетки: убираем затемнение, когда докрутили до конца
  const gridEl = document.getElementById('grid');
  const syncGridFade = () => {
    if (!gridEl) return;
    const atEnd = gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 6;
    gridEl.classList.toggle('at-end', atEnd);
    // прокрутили — включаем мягкое растворение верхнего края под баром
    gridEl.classList.toggle('has-scroll-top', gridEl.scrollTop > 4);
  };
  if (gridEl) {
    gridEl.addEventListener('scroll', syncGridFade, { passive: true });
    gridEl.addEventListener('scroll', scheduleCoverHydrate, { passive: true });
    new MutationObserver(syncGridFade).observe(gridEl, { childList: true });
    window.addEventListener('resize', syncGridFade);
    window.addEventListener('resize', scheduleCoverHydrate);
    setTimeout(syncGridFade, 600);
  }

  // search
  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    searchQuery = search.value.trim();
    recomputeSearch();
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      if (!searchMatches.length) return;
      searchIndex = (searchIndex + 1) % searchMatches.length;
      highlightSearch();
      const s = sounds.get(searchMatches[searchIndex].id);
      if (s) setNowPlaying(s);
    } else if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (!searchMatches.length) return;
      const idx = searchIndex >= 0 && searchIndex < searchMatches.length ? searchIndex : 0;
      playCmd(searchMatches[idx].id); // перелистывание: новый звук глушит предыдущий
    }
  });

  // grid interactions: клик = играть/стоп, удержание 500мс = режим выбора, двойной клик = свойства
  const grid = document.getElementById('grid');
  grid.addEventListener('click', (e) => {
    const node = e.target.closest('.sound');
    if (!node) {
      // клик по пустому месту — выйти из режима выбора
      if (selection.size) clearSelection();
      return;
    }
    const now = Date.now();
    // клик сразу после драга/передвижения карточки — не играть
    if (now < suppressAllUntil) return;
    // клик той же карточки сразу после удержания/двойного клика — подавить,
    // чтобы отпускание не снимало только что поставленную галочку
    if (now < suppressClickUntil && node === suppressCard) return;
    // Ctrl+клик — выделение карточек для переноса нескольких песен (не играет)
    if (e.ctrlKey || e.metaKey) {
      toggleSel(node);
      e.preventDefault();
      return;
    }
    // режим выбора: клик — поставить/снять галочку, не играет
    if (selection.size) {
      toggleSel(node);
      e.preventDefault();
      return;
    }
    // если это «второй клик» той же карточки — это часть двойного клика, не играем
    if (now - lastClickAt < 350 && node === lastClickNode) {
      lastClickAt = now;
      if (playTimer) { clearTimeout(playTimer); playTimer = null; }
      suppressClickUntil = now + 400;
      suppressCard = node;
      return;
    }
    lastClickAt = now;
    lastClickNode = node;
    if (now < suppressClickUntil) return;
    // запускаем сразу по клику — раньше здесь стояла задержка 280 мс
    // «на распознавание двойного клика», из-за неё старт ощущался медленным
    playSound(node.dataset.id);
  });
  grid.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.sound');
    if (!node || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) return;
    heldId = node.dataset.id;
    pressX = e.clientX; pressY = e.clientY;
    // декодируем файл уже на нажатие — к моменту click буфер чаще готов
    const ps = sounds.get(node.dataset.id);
    if (ps && !ps._prefetched) { ps._prefetched = true; engine.getBuffer(ps.path).catch(() => {}); }
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const id = heldId;
      heldId = null;
      suppressClickUntil = Date.now() + 700;
      suppressCard = node;
      const wasEmpty = selection.size === 0;
      if (!selection.has(id)) { selection.add(id); node.classList.add('sel'); }
      grid.classList.toggle('multi', selection.size > 1);
      if (wasEmpty) toast('Режим выбора: кликай по песням, затем перетащи одну из них', 'success');
    }, 450);
  });
  grid.addEventListener('pointerup', (e) => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    // отпускание после реального движения (не клик) — подавить клик, иначе
    // «передвинул карточку и она заиграла»
    if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > 10) suppressAllUntil = Date.now() + 500;
    heldId = null;
  });
  // отмена удержания только при реальном движении (>10px) — микро-дрожь не мешает выбору
  grid.addEventListener('pointermove', (e) => {
    if (holdTimer && heldId) {
      const dx = e.clientX - pressX, dy = e.clientY - pressY;
      if (dx * dx + dy * dy > 100) { clearTimeout(holdTimer); holdTimer = null; }
    }
  });
  grid.addEventListener('dblclick', (e) => {
    const node = e.target.closest('.sound');
    if (!node) return;
    if (e.ctrlKey || e.metaKey) { clearSelection(); return; }
    if (selection.size) return; // в режиме выбора двойной клик не открывает свойства
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    suppressClickUntil = Date.now() + 400;
    suppressCard = node;
    const s = sounds.get(node.dataset.id);
    if (!s) return;
    if (s.playing) stopSound(s);
    propertiesModal(s);
  });
  grid.addEventListener('contextmenu', (e) => {
    const node = e.target.closest('.sound');
    if (!node) return;
    e.preventDefault();
    uiSound('menu');
    openContextMenu(e.clientX, e.clientY, node.dataset.id);
  });

  // 3D tilt за мышкой: карточка наклоняется по позиции курсора + блик следует за ним
  let tiltCard = null;
  let tiltRAF = null;
  grid.addEventListener('pointermove', (e) => {
    if (config.tilt === false) return;
    const node = e.target.closest('.sound');
    if (!node) return;
    const r = node.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (tiltRAF) cancelAnimationFrame(tiltRAF);
    tiltRAF = requestAnimationFrame(() => {
      tiltRAF = null;
      node.style.setProperty('--rx', ((0.5 - y) * 8).toFixed(2) + 'deg');
      node.style.setProperty('--ry', ((x - 0.5) * 10).toFixed(2) + 'deg');
      node.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
      node.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      if (tiltCard && tiltCard !== node) tiltCard.classList.remove('tilt');
      node.classList.add('tilt');
      tiltCard = node;
    });
  });
  grid.addEventListener('pointerleave', () => {
    if (tiltCard) { tiltCard.classList.remove('tilt'); tiltCard = null; }
  });

  // звуки интерфейса: наведение + клики (делегирование с защитой от дребезга)
  document.addEventListener('pointerover', (e) => {
    if (dragIds.length) return;
    const btn = e.target.closest('.btn,.fbtn,.small-btn,.side-btn,.new-set,.win,.set,.hist-item,.cm-item,.range,.ob-navbtn,.ob-tab');
    const card = e.target.closest('.sound');
    const hit = btn || card;
    if (hit && hit !== uiHoverEl) { uiHoverEl = hit; uiSound(card && !btn ? 'cardHover' : 'hover'); }
    else if (!hit) uiHoverEl = null;
  });
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn,.fbtn,.small-btn,.side-btn,.new-set,.win,.set,.hist-item,.cm-item');
    const card = e.target.closest('.sound');
    if (btn) { uiSound('click'); return; }
    if (card && e.button === 0) uiSound('cardClick');
  });
  document.addEventListener('change', (e) => {
    if (!e.target.matches('.switch input')) return;
    uiSound('toggle');
    if (e.target.id === 's-ui-sounds') {
      config.uiSounds = e.target.checked;
      api.settingsSet({ uiSounds: !!config.uiSounds }).catch(() => {});
      toast(config.uiSounds ? 'Звуки интерфейса: вкл' : 'Звуки интерфейса: выкл');
    }
  });
  // круглые регуляторы: тик при кручении (анти-спам режет частоту)
  document.addEventListener('input', (e) => {
    if (e.target.matches('.range')) uiSound('click');
  });

  // --- внутреннее перетаскивание карточек: перестановка + перенос в набор ---
  const DRAG_MIME = 'application/x-soundpad';
  let dragIds = [];                      // id карточек, которые тащим
  let dragTargetCard = null;             // карточка-цель при перестановке
  let gridEnd = false;                   // группа уже втиснута в конец сетки
  // FLIP: плавный сдвиг карточек, которые расступаются под перетаскиваемую группу
  const flipAfterReorder = () => {
    const kids = [...grid.children];
    const before = new Map(kids.map((n) => [n, n.getBoundingClientRect()]));
    return () => {
      for (const n of kids) {
        if (!n.isConnected || dragIds.includes(n.dataset.id)) continue;
        const b = before.get(n);
        if (!b) continue;
        const a = n.getBoundingClientRect();
        const dx = b.left - a.left, dy = b.top - a.top;
        if (!dx && !dy) continue;
        n.style.transition = 'none';
        n.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        void n.offsetWidth;
        n.style.transition = '';
        n.style.transform = '';
      }
    };
  };

  const selEls = () => dragIds.map((id) => els.get(id)).filter(Boolean);
  const toggleSel = (node) => {
    const id = node.dataset.id;
    if (selection.has(id)) { selection.delete(id); node.classList.remove('sel'); }
    else { selection.add(id); node.classList.add('sel'); }
    grid.classList.toggle('multi', selection.size > 1);
    uiSound('select');
  };
  const clearSelection = () => {
    selection.clear();
    grid.classList.remove('multi');
    for (const el of document.querySelectorAll('.sound.sel')) el.classList.remove('sel');
  };
  const clearDragMarks = () => {
    grid.classList.remove('drag-over');
    clearDropHighlight();
    if (dragTargetCard) { dragTargetCard.classList.remove('drag-over-card'); dragTargetCard = null; }
    for (const el of selEls()) el.classList.remove('dragging');
  };
  // зафиксировать порядок сетки в config.sounds
  const commitDragOrder = () => {
    const domIds = [...grid.querySelectorAll('.sound')].map((n) => n.dataset.id);
    const pos = new Map(domIds.map((id, i) => [id, i]));
    config.sounds.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  };

  grid.addEventListener('dragstart', (e) => {
    const node = e.target.closest('.sound');
    if (!node) return;
    // тащить можно только карточки с галочкой (выделенные группой);
    // любой другой драг-инициация ({джиггл} при удержании) отменяем,
    // чтобы он не сбрасывал режим выбора
    if (!selection.has(node.dataset.id)) { e.preventDefault(); return; }
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; heldId = null; }
    suppressClickUntil = Date.now() + 700;
    suppressCard = node;
    dragIds = [...selection];
    e.dataTransfer.setData(DRAG_MIME, '1');
    e.dataTransfer.effectAllowed = 'move';
    for (const el of selEls()) el.classList.add('dragging');
  });

  const handleDragMove = (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    grid.classList.add('drag-over');
    // автопрокрутка при перетаскивании к краям сетки
    const gr = grid.getBoundingClientRect();
    if (e.clientY < gr.top + 80) grid.scrollTop = Math.max(0, grid.scrollTop - 24);
    else if (e.clientY > gr.bottom - 80) grid.scrollTop = Math.min(grid.scrollHeight, grid.scrollTop + 24);
    const card = e.target.closest('.sound');
    const firstCard = grid.firstElementChild;
    const lastCard = grid.lastElementChild;
    if (card && !dragIds.includes(card.dataset.id) && card !== dragTargetCard) {
      if (dragTargetCard) dragTargetCard.classList.remove('drag-over-card');
      dragTargetCard = card;
      card.classList.add('drag-over-card');
      gridEnd = false;
      const nodes = selEls();
      if (nodes.length) {
        const animate = flipAfterReorder();
        const first = nodes[0];
        if (card.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_PRECEDING) {
          // цель выше группы — вставить группу перед целью
          nodes.forEach((n) => grid.insertBefore(n, card));
        } else {
          nodes.forEach((n) => grid.insertBefore(n, card.nextSibling));
        }
        animate();
      }
    } else if (!gridEnd && lastCard) {
      const lr = lastCard.getBoundingClientRect();
      // пустое место под последним рядом ИЛИ справа от последней карточки
      // (неполный ряд) — «втискиваем» группу в самый конец
      if (e.clientY > lr.bottom + 4 || e.clientX > lr.right + 4) {
        gridEnd = true;
        const nodes = selEls();
        if (nodes.length) {
          const animate = flipAfterReorder();
          nodes.forEach((n) => grid.appendChild(n));
          animate();
        }
      }
    } else if (!gridEnd && firstCard && e.clientY < firstCard.getBoundingClientRect().top - 4) {
      // пустое место над первым рядом — в самое начало
      gridEnd = true;
      const nodes = selEls();
      if (nodes.length) {
        const animate = flipAfterReorder();
        nodes.forEach((n) => grid.insertBefore(n, firstCard));
        animate();
      }
    }
    const setEl = e.target.closest('.set');
    if (setEl && setEl.dataset.cat) {
      if (dropSetEl !== setEl) clearDropHighlight();
      dropSetEl = setEl;
      setEl.style.borderColor = 'rgba(80,230,157,.8)';
      setEl.style.background = 'rgba(80,230,157,.12)';
    } else {
      clearDropHighlight();
    }
  };
  document.addEventListener('dragover', handleDragMove);
  document.addEventListener('dragenter', handleDragMove);

  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    let moved = false;
    const setEl = e.target.closest('.set');
    if (setEl && setEl.dataset.cat && setEl.dataset.cat !== 'all') {
      const catId = setEl.dataset.cat === 'none' ? '' : setEl.dataset.cat;
      const moving = new Set(dragIds);
      const catName = catId ? ((config.categories.find((c) => c.id === catId) || {}).name || 'набор') : 'на главную страницу';
      for (const s of config.sounds) if (moving.has(s.id)) s.category = catId;
      const before = config.sounds.filter((s) => s.category === catId && !moving.has(s.id));
      const rest = config.sounds.filter((s) => !moving.has(s.id));
      // переносимые песни встают в том же порядке, в котором их выделили (паравозик)
      const ordered = [];
      for (const id of dragIds) { const s = config.sounds.find((x) => x.id === id); if (s) ordered.push(s); }
      config.sounds = [...before, ...ordered, ...rest.filter((s) => s.category !== catId)];
      saveConfig();
      render();
      clearSelection();
      toast('Перемещено в «' + catName + '»', 'success');
      moved = true;
    }
    clearDragMarks();
    if (!moved) { commitDragOrder(); saveConfig(); clearSelection(); }
    dragIds = [];
    gridEnd = false;
  });

  grid.addEventListener('dragend', () => {
    if (!dragIds.length) return;
    uiSound('drop');
    // клик, который Chromium шлёт после драга — подавить, чтобы песня не включилась
    suppressAllUntil = Date.now() + 800;
    for (const el of selEls()) { el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 260); }
    clearDragMarks();
    commitDragOrder();
    saveConfig();
    clearSelection();
    dragIds = [];
    gridEnd = false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selection.size) clearSelection();
  });

  // drag & drop (можно бросать на конкретный набор в сайдбаре)
  let dropSetEl = null;
  const clearDropHighlight = () => {
    if (dropSetEl) { dropSetEl.style.borderColor = ''; dropSetEl.style.background = ''; dropSetEl = null; }
  };
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    grid.classList.add('drag-over');
    const setEl = e.target.closest('.set');
    if (setEl && setEl.dataset.cat) {
      if (dropSetEl !== setEl) clearDropHighlight();
      dropSetEl = setEl;
      setEl.style.borderColor = 'rgba(85,168,255,.8)';
      setEl.style.background = 'rgba(85,168,255,.14)';
    } else {
      clearDropHighlight();
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('drag-over');
    if (dropSetEl && !dropSetEl.contains(e.relatedTarget)) clearDropHighlight();
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    grid.classList.remove('drag-over');
    clearDropHighlight();
    const files = [...(e.dataTransfer.files || [])]
      .map((f) => ({ name: f.name, path: (api.getPathForFile && f.path == null) ? api.getPathForFile(f) : (f.path || '') }))
      .filter((f) => f.path);
    if (!files.length) return;
    const setEl = e.target.closest('.set');
    let catId;
    if (setEl && setEl.dataset.cat === 'none') catId = '';
    else if (setEl && setEl.dataset.cat && setEl.dataset.cat !== 'all') catId = setEl.dataset.cat;
    addSoundFiles(files, catId);
  });

  // close context menu / modal on outside click
  document.addEventListener('click', (e) => {
    if (!cmEl.classList.contains('hidden') && !cmEl.contains(e.target)) hideContextMenu();
  });

  // global hotkeys from main
  api.onHotkey((p) => {
    p = p || {};
    if (p.type === 'cmd') { runCmd(p.cmd); return; }
    if (p.type === 'index') {
      const list = soundsInSet();
      const s = list[p.index];
      if (s) playSound(s.id);
      return;
    }
    if (p.type === 'sound') {
      const s = sounds.get(p.id);
      if (s) playSound(p.id);
      return;
    }
    if (p.type === 'ptt') {
      toast(p.held ? 'Войс-чат: клавиша «' + (config.pttKey || 'T') + '» зажата — говорите' : 'Войс-чат: клавиша «' + (config.pttKey || 'T') + '» отпущена', p.held ? 'success' : '');
      return;
    }
  });

  // локальные хоткеи: одинарные буквы/цифры (пока окно в фокусе)
  document.addEventListener('keydown', localHotkeyHandler, true);

  api.onHotkeyError((accel) => {
    if (pendingHotkey && pendingHotkey.accel === accel) {
      toast('Не удалось зарегистрировать клавишу ' + prettyHotkey(accel) + ' (занята системой)', 'error');
      const { s, prev } = pendingHotkey;
      delete hotkeyMap[s.id];
      s.hotkey = prev || null;
      if (prev) hotkeyMap[s.id] = prev;
      api.hotkeysSet(hotkeyMap);
      saveConfig();
      render();
      pendingHotkey = null;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('modal-overlay').classList.contains('hidden')) closeModal();
      hideContextMenu();
    }
  });
}

function recomputeSearch() {
  searchIndex = -1;
  if (!searchQuery) { searchMatches = []; return; }
  const q = searchQuery.toLowerCase();
  searchMatches = soundsInSet().filter((s) => s.name.toLowerCase().includes(q));
}

function highlightSearch() {
  for (const el of queryAll('.sound')) el.classList.remove('found');
  if (searchIndex < 0 || searchIndex >= searchMatches.length) return;
  const el = els.get(searchMatches[searchIndex].id);
  if (el) el.classList.add('found');
}

// helpers
function queryAll(sel) { return [...document.querySelectorAll(sel)]; }

async function init() {
  const st = await api.storeGet();
  window.__tStore = performance.now(); // библиотека/настройки пришли из main
  const saved = (st && st.settings) || {};
  const lib = (st && st.data) || { sounds: [] };

  config = {
    ...DEFAULT_CONFIG,
    masterVolume: typeof saved.masterVolume === 'number' ? saved.masterVolume : DEFAULT_CONFIG.masterVolume,
    monitor: saved.monitor != null ? saved.monitor : DEFAULT_CONFIG.monitor,
    monitorVol: typeof saved.monitorVol === 'number' ? saved.monitorVol : DEFAULT_CONFIG.monitorVol,
    micEnabled: saved.micEnabled != null ? saved.micEnabled : DEFAULT_CONFIG.micEnabled,
    overlap: saved.overlapMode ? saved.overlapMode === 'overlap' : DEFAULT_CONFIG.overlap,
    all: !!saved.allMode,
    bass: saved.fartLevel != null ? saved.fartLevel : DEFAULT_CONFIG.bass,
    mute: saved.mute != null ? saved.mute : DEFAULT_CONFIG.mute,
    selfOff: !!saved.selfOff,
    outputDevice: saved.outputDeviceId || '',
    speakerDevice: saved.speakerDeviceId || '',
    voiceMix: !!saved.voiceMix,
    voiceMicId: saved.voiceMicId || '',
    voiceVolume: typeof saved.voiceVolume === 'number' ? saved.voiceVolume : 100,
    voiceGate: typeof saved.voiceGate === 'number' ? saved.voiceGate : 0,
    cableOff: !!saved.cableOff,
    cableRouteDone: !!saved.cableRouteDone,
    _autoPickMic: saved.outputDeviceId === undefined,  // пользователь не выбирал — автопоиск один раз
    _autoPickSpk: saved.speakerDeviceId === undefined,
    normalize: !!saved.normalize,
    voiceActivation: !!saved.voiceActivation,
    ducking: saved.ducking != null ? !!saved.ducking : true,
    duckLevel: typeof saved.duckLevel === 'number' ? saved.duckLevel : 0.28,
    openAtLogin: !!saved.openAtLogin,
    padScale: saved.padScale != null ? saved.padScale : 1,
    background: saved.background || '',
    blur: saved.blur != null ? !!saved.blur : true,
    glassMode: saved.blur === false ? 'off' : 'blur',
    glassModePrev: 'blur',
    indexHotkeys: saved.indexHotkeys != null ? !!saved.indexHotkeys : true,
    passHotkeys: !!saved.passHotkeys,
    singleKeysGlobal: !!saved.singleKeysGlobal,
    prefixMode: !!saved.prefixMode,
    prefixKey: saved.prefixKey || '\\',
    uiSounds: saved.uiSounds != null ? !!saved.uiSounds : true,
pttKey: saved.pttKey || 'T',
    specialHotkeys: { ...(saved.specialHotkeys || { stop: 'F8' }) },
    autoNext: saved.autoNext != null ? !!saved.autoNext : true,
    shuffle: !!saved.shuffle,
    loopOne: !!saved.loopOne,
    accent: /^#[0-9a-f]{6}$/i.test(saved.accent || '') ? saved.accent : DEFAULT_CONFIG.accent,
    radius: typeof saved.radius === 'number' ? saved.radius : DEFAULT_CONFIG.radius,
    cardScale: typeof saved.cardScale === 'number' ? saved.cardScale : DEFAULT_CONFIG.cardScale,
    bgDim: typeof saved.bgDim === 'number' ? saved.bgDim : DEFAULT_CONFIG.bgDim,
    aurora: saved.aurora != null ? !!saved.aurora : DEFAULT_CONFIG.aurora,
    anims: saved.anims != null ? !!saved.anims : DEFAULT_CONFIG.anims,
    animSpeed: typeof saved.animSpeed === 'number' ? saved.animSpeed : DEFAULT_CONFIG.animSpeed,
    tilt: saved.tilt != null ? !!saved.tilt : DEFAULT_CONFIG.tilt,
    categories: Array.isArray(saved.categories) && saved.categories.length ? saved.categories : DEFAULT_CONFIG.categories,
    onboarded: !!saved.onboarded,
    tourDone: !!saved.tourDone,
    onboardingRev: +saved.onboardingRev || 0,
    sounds: Array.isArray(lib.sounds) ? lib.sounds : []
  };
  hotkeyMap = { ...(saved.hotkeys || {}) };
  resumeState = saved.resume && saved.resume.id
    ? { id: saved.resume.id, pos: +saved.resume.pos || 0, ts: +saved.resume.ts || 0 }
    : null;

  for (const s of config.sounds) {
    if (s.mode == null) s.mode = 'mic';
    if (s.volume == null) s.volume = 1;
    if (s.rate == null) s.rate = 1;
    if (!s.hotkey && hotkeyMap[s.id]) s.hotkey = hotkeyMap[s.id];
    sounds.set(s.id, s);
  }

  // перерегистрировать горячие клавиши сразу при старте, чтобы привязки пережили перезапуск
  api.hotkeysSet(hotkeyMap);
  api.specialHotkeysSet(config.specialHotkeys);

  // engine initial state
  engine.setMicDevice(config.outputDevice);
  engine.setSpeakerDevice(config.speakerDevice);
  engine.setVolume(config.masterVolume);
  engine.setMute(config.mute);
  engine.setMonitorVol(config.monitorVol);
  engine.setMonitor(config.monitor);
  engine.setFart(config.bass);
  engine.setNormalize(config.normalize);
  engine.setVoiceActivation(config.voiceActivation);
  engine.setVoiceVolume((config.voiceVolume != null ? config.voiceVolume : 100) / 100);
  engine.setVoiceGate(((config.voiceGate != null ? config.voiceGate : 0) / 100) * 0.02);
  engine.setDuckAmount(config.duckLevel != null ? config.duckLevel : 0.28);
  applyPad();
  applyBackground();
  applyBlur();
  applyAppearance();
  updateBlurUi();

  // migrate old category format
  const hasOld = config.categories.some((c) => typeof c === 'string');
  if (hasOld) {
    config.categories = config.categories.map((c) => typeof c === 'string' ? { id: 'c_' + randomId(), name: c } : c);
    saveConfig();
  }

  bindUI();
  watchAppearance();
  if (api.onTrayMode) api.onTrayMode(setTrayMode);
  // сначала показываем интерфейс, тяжёлое (устройства/микрофон) — после первого кадра
  render();
  if (window.SPGlass) window.SPGlass.refresh();
  window.__bootMs = Math.round(performance.now());
  window.__bootAt = performance.now();
  // Мастер показываем сразу, не дожидаясь перечисления устройств: оно может занять
  // десятки секунд, и раньше окно выглядело так, будто обучение вообще не открылось.
  maybeStartOnboarding();
  refreshDevices().then(() => {
    ensureCableRoute();
    if (config.voiceMix) applyVoiceMix().catch(() => {});
    if (obOpen) { obCheckVirtualMic(); obFillDevices(); }
  }).catch(() => {});
  // дакинг слушает микрофон: запускаем не на старте, чтобы окно открывалось быстрее
  setTimeout(() => { try { engine.setDucking(config.ducking !== false); } catch {} }, 900);
  // прогрев буферов фоном — чтобы звуки включались сразу
  // прогрев буферов фоном — чтобы звуки включались сразу;
  // НЕ все подряд (декод грузит процессор): только хоткей-звуки и топ-3 популярных,
  // для мыши мгновенно работает префетч по наведению
  if (location.hash !== '#test') {
    const top = config.sounds
      .slice()
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .slice(0, 3);
    const hot = config.sounds.filter((s) => s.hotkey);
    const toWarm = [];
    for (const s of [...hot, ...top]) if (!toWarm.includes(s)) toWarm.push(s);
    engine.warmup(toWarm).catch(() => {});
    // после первого кадра — неспешный прогрев первых карточек на экране,
    // чтобы даже холодный клик по ним не ждал декодирования
    setTimeout(() => {
      try { engine.warmup(visibleSounds().slice(0, 10), 10).catch(() => {}); } catch {}
    }, 6000);
  }
}

// ==================== Мастер первого запуска ====================
// Показывается один раз (пока в настройках не сохранено onboarded:true).
// Задача: объяснить, что установить (VB-CABLE), что выбрать в голосовой чат и
// как проверить звук — без чтения README.
// ==================== Мастер настройки и обучения ====================
// Часть 1 — настройка звука (виртуальный микрофон, устройства, подключение).
// Часть 2 — короткое обучение: как добавлять звуки, играть, вешать клавиши.
// Показывается один раз; в настройках можно пройти заново.
let obSlides = [];
let obStep = 0;
let obInited = false;
let obOpen = false;

// Версия мастера. Если она больше сохранённой, мастер показывается заново —
// иначе после обновления пользователь видит старый экран и думает, что ничего не поменялось.
const ONBOARD_REV = 10;
let obUser = '';          // имя пользователя Windows
let obInfoLoaded = false;

function maybeStartOnboarding() {
  // Мастер показываем только пока он реально не пройден. Раньше сюда был
  // завязан ещё и номер ревизии — из-за этого обучение могло выскочить
  // повторно после обновления. Прошли один раз — больше не показываем.
  if (config.onboarded && config.tourDone) return;
  initOnboarding();
  const root = document.getElementById('onboard');
  if (!root) return;
  obOpen = true;
  root.classList.remove('hidden');
  const firstTour = obSlides.findIndex((s) => s.dataset.phase === 'tour');
  const start = config.onboarded ? Math.max(0, firstTour) : 0;
  obShow(start);
  if (!config.onboarded) { obCheckVirtualMic(); obFillDevices(); }
  obPersonalize();
  if (window.SPGlass) window.SPGlass.refresh();
}

function initOnboarding() {
  if (obInited) return;
  obInited = true;
  const root = document.getElementById('onboard');
  if (!root) return;
  obSlides = Array.from(root.querySelectorAll('.ob-slide'));

  document.getElementById('ob-next').addEventListener('click', () => {
    uiSound('click');
    obBtnPulse(document.getElementById('ob-next'));
    const cur = obSlides[obStep];
    const phase = cur ? cur.dataset.phase : 'setup';
    const lastSetup = lastIndexByPhase('setup');
    const lastTour = lastIndexByPhase('tour');
    if (phase === 'setup' && obStep === lastSetup) { obEndSetup(); return; }
    if (phase === 'tour' && obStep === lastTour) { obFinishAll(); return; }
    obPageAnim('next');
    obShow(obStep + 1);
  });
  document.getElementById('ob-back').addEventListener('click', () => {
    uiSound('click');
    obBtnPulse(document.getElementById('ob-back'));
    const firstTour = firstIndexByPhase('tour');
    if (obStep === 0 || obStep === firstTour) return;
    obPageAnim('back');
    obShow(obStep - 1);
  });
  document.getElementById('ob-skip').addEventListener('click', () => {
    uiSound('close');
    const cur = obSlides[obStep];
    if (cur && cur.dataset.phase === 'setup') obEndSetup();
    else obFinishAll();
  });
  document.getElementById('ob-vb-install').addEventListener('click', () => {
    uiSound('click');
    api.openExternal('https://vb-audio.com/Cable/').catch(() => {});
    toast('Открыл сайт VB-Audio — скачай пакет и нажми в установщике «Install Driver»');
  });
  document.getElementById('ob-vb-have').addEventListener('click', () => {
    uiSound('click');
    if (obStep < lastIndexByPhase('setup')) obShow(obStep + 1);
    obFillDevices();
  });

  const outSel = document.getElementById('ob-out-device');
  const spkSel = document.getElementById('ob-spk-device');
  outSel.addEventListener('change', () => {
    uiSound('select');
    config.outputDevice = outSel.value;
    config._noAutoMic = true;
    engine.setMicDevice(config.outputDevice);
    saveConfig();
    obFillDevices();
    obUpdateRouteName();
  });
  spkSel.addEventListener('change', () => {
    uiSound('select');
    config.speakerDevice = spkSel.value;
    engine.setSpeakerDevice(config.speakerDevice);
    saveConfig();
  });

  const tabs = document.getElementById('ob-tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('.ob-tab');
      if (!b) return;
      uiSound('menu');
      const m = obTourGroups().find((x) => x.g === b.dataset.group);
      if (m) { obPageAnim(m.start > obStep ? 'next' : 'back'); obShow(m.start); }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!obOpen) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      const th = document.getElementById('ob-theater');
      if (th && !th.classList.contains('hidden')) { e.preventDefault(); obCloseTheater(); }
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const n = document.getElementById('ob-next');
      if (n) n.click();
    } else if (e.key === 'ArrowLeft') {
      const b = document.getElementById('ob-back');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  });

  initOnboardVideos();
}

function obPageAnim(dir) {
  const el = document.getElementById('ob-body');
  if (!el) return;
  const cls = dir === 'back' ? 'anim-back' : 'anim-next';
  el.classList.remove('anim-next', 'anim-back');
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(obPageAnim._t);
  obPageAnim._t = setTimeout(() => el.classList.remove(cls), 400);
}

function obBtnPulse(btn) {
  if (!btn) return;
  btn.classList.remove('pressed');
  void btn.offsetWidth;
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 340);
}

function lastIndexByPhase(phase) {
  for (let i = obSlides.length - 1; i >= 0; i--) if (obSlides[i].dataset.phase === phase) return i;
  return -1;
}
function firstIndexByPhase(phase) {
  for (let i = 0; i < obSlides.length; i++) if (obSlides[i].dataset.phase === phase) return i;
  return -1;
}

// Точки в шапке: каждый шаг настройки — своя точка, обучение — по точке на модуль.
function obSectionStartIndexes() {
  const res = [];
  let lastGroup = null;
  obSlides.forEach((s, i) => {
    if (s.dataset.phase !== 'tour') { res.push(i); return; }
    const g = s.dataset.group || 'x';
    if (g !== lastGroup) { res.push(i); lastGroup = g; }
  });
  return res;
}

// Пока открыт слайд с демонстрацией клавиш, глобальные хоткеи приложения
// временно отключаем: иначе перехватчик префикса (\ ) забирает нажатие себе,
// и демо не видит, что клавиша нажата.
let obHotkeysMuted = false;
function obSetHotkeysMuted(on) {
  if (obHotkeysMuted === on) return;
  obHotkeysMuted = on;
  try { if (api.suppressHotkeys) api.suppressHotkeys(on).catch(() => {}); } catch {}
}

function obShow(step) {
  // при любом переходе сначала глушим всё: старый слайд не должен
  // доигрывать поверх нового
  document.querySelectorAll('#onboard video').forEach((v) => {
    try { if (!v.paused) v.pause(); } catch {}
  });
  obStep = Math.max(0, Math.min(obSlides.length - 1, step));
  const root = document.getElementById('onboard');
  if (!root) return;
  obSlides.forEach((s, i) => s.classList.toggle('active', i === obStep));
  const cur = obSlides[obStep];
  if (!cur) return;
  // на слайде «Горячие клавиши» глобальный перехват выключаем — иначе он
  // съедает префикс и демо кажется неработающим
  obSetHotkeysMuted(cur.dataset.hotkeys === '1');
  const phase = cur.dataset.phase || 'setup';

  const firstOfPhase = firstIndexByPhase(phase);
  const lastOfPhase = lastIndexByPhase(phase);

  const tabs = document.getElementById('ob-tabs');
  const phaseEl = document.getElementById('ob-phase');
  const cap = document.getElementById('ob-cap');
  const prog = document.getElementById('ob-prog');
  const count = document.getElementById('ob-count');

  if (phaseEl) phaseEl.textContent = phase === 'tour' ? 'Обучение' : 'Настройка';
  if (tabs) tabs.classList.toggle('hidden', phase !== 'tour');

  const groups = obTourGroups();
  const gi = groups.findIndex((g) => g.g === (cur.dataset.group || '1'));

  if (phase === 'setup') {
    const n = obStep - firstOfPhase; // 0 — приветствие, дальше шаги 1..3
    if (cap) cap.innerHTML = '<b>Мастер настройки</b>' + (n === 0 ? 'приветствие' : 'шаг ' + n + ' из 3');
    if (prog) prog.innerHTML = '<div class="ob-pseg" style="flex:1 1 0"><i style="width:' +
      Math.round(((n + 1) / 4) * 100) + '%"></i></div>';
    if (count) count.textContent = n === 0 ? 'Начало' : 'Шаг ' + n + ' из 3';
  } else if (gi >= 0) {
    const mod = groups[gi];
    const splash = cur.dataset.splash === '1';
    const pageNo = splash ? 0 : mod.content.indexOf(obStep) + 1;
    const pages = mod.content.length;

    if (tabs) {
      tabs.innerHTML = groups.map((m, k) => {
        const cls = k < gi ? 'done' : (k === gi ? 'on' : '');
        const num = k < gi ? '✓' : String(k + 1);
        return '<button class="ob-tab ' + cls + '" data-group="' + m.g + '"><i>' + num + '</i><span>' +
          m.name + '</span></button>';
      }).join('');
    }

    if (cap) {
      cap.innerHTML = '<b>Обучение · ' + (gi + 1) + ' из ' + groups.length + '</b>' +
        (splash ? pages + ' экранов' : 'страница ' + pageNo + ' из ' + pages);
    }

    if (prog) {
      const total = groups.reduce((a, m) => a + m.content.length, 0);
      let before = 0;
      for (let k = 0; k < gi; k++) before += groups[k].content.length;
      const curN = before + (splash ? 1 : pageNo);
      let off = 0;
      prog.innerHTML = groups.map((m) => {
        const c = m.content.length;
        const f = Math.max(0, Math.min(c, curN - off));
        off += c;
        return '<div class="ob-pseg" style="flex:' + c + ' 1 0"><i style="width:' +
          (c ? (f / c) * 100 : 0) + '%"></i></div>';
      }).join('');
      if (count) count.textContent = curN + ' из ' + total;
    }
  }

  const back = document.getElementById('ob-back');
  if (back) back.disabled = obStep === 0 || obStep === firstOfPhase;

  const next = document.getElementById('ob-next');
  if (next) {
    if (phase === 'setup') {
      next.textContent = obStep === lastOfPhase ? 'К обучению →'
        : (obStep === 0 ? 'Начать настройку →' : 'Дальше →');
    } else {
      next.textContent = obStep === lastOfPhase ? 'Готово' : 'Дальше →';
    }
  }
  const skip = document.getElementById('ob-skip');
  if (skip) skip.textContent = phase === 'tour' ? 'Пропустить обучение' : 'Пропустить настройку';

  const body = document.getElementById('ob-body');
  if (body) body.scrollTop = 0;
  cur.scrollTop = 0;
  cur.querySelectorAll('.ob-text').forEach((el) => { el.scrollTop = 0; });
  cur.querySelectorAll('.ob-bullets').forEach((el) => { el.scrollTop = 0; });

  if (phase === 'setup') {
    if (obStep === 0) obPersonalize();
    if (obStep === 1) obCheckVirtualMic();
    if (obStep === 2) obFillDevices();
    if (obStep === 3) obUpdateRouteName();
  }
  if (phase === 'tour' && obStep === firstOfPhase) {
    // при переходе к обучению обновляем устройства, если драйвер поставили только что
    obFillDevices();
  }

  obSyncVideos();
}

// Модули обучения: имя, стартовый слайд (заставка) и индексы содержательных экранов.
function obTourGroups() {
  const names = { '1': 'Кнопки', '2': 'Песни и наборы', '3': 'Настройки' };
  const res = [];
  let group = null;
  obSlides.forEach((s, i) => {
    if (s.dataset.phase !== 'tour') return;
    const g = s.dataset.group || '1';
    if (!group || group.g !== g) {
      group = { g, name: names[g] || ('Модуль ' + g), start: i, content: [] };
      res.push(group);
    }
    if (s.dataset.splash !== '1') group.content.push(i);
  });
  return res;
}

function obEndSetup() {
  config.onboarded = true;
  saveConfig();
  if (api.settingsSet) api.settingsSet({ onboarded: true }).catch(() => {});
  const firstTour = firstIndexByPhase('tour');
  if (firstTour >= 0) {
    obShow(firstTour);
    toast('Настройка готова — теперь короткое обучение', 'success');
  } else {
    obFinishAll();
  }
}

function obFinishAll() {
  config.onboarded = true;
  config.tourDone = true;
  config.onboardingRev = ONBOARD_REV;
  saveConfig();
  if (api.settingsSet) api.settingsSet({ onboarded: true, tourDone: true, onboardingRev: ONBOARD_REV }).catch(() => {});
  obCloseTheater();
  obSetHotkeysMuted(false);
  obParticlesStop();
  document.querySelectorAll('#onboard video').forEach((v) => {
    try { obVidRelease(v); } catch {}
  });
  // страховка: у роликов, чей play() ещё не успел разрешиться, флаг «играет»
  // может остаться после освобождения — гасим его, когда закрытие отыграло
  setTimeout(() => {
    document.querySelectorAll('#onboard video').forEach((v) => {
      try { if (!v.paused) v.pause(); } catch {}
    });
  }, 260);
  const root = document.getElementById('onboard');
  obOpen = false;
  if (!root) return;
  root.classList.add('closing');
  setTimeout(() => {
    root.classList.add('hidden');
    root.classList.remove('closing');
    if (window.SPGlass) window.SPGlass.refresh();
  }, 220);
}

// ---- персонализация мастера ----
// Никаких «мой микрофон / стерео» из шаблона: показываем реальные устройства
// и данные конкретного пользователя.
function obHumanName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^[0-9]+$/.test(s)) return '';            // «20101» — не имя
  if (s.length < 2 || s.length > 24) return '';
  if (/^(user|admin|administrator|default)$/i.test(s)) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function obLoadUser() {
  if (obInfoLoaded) return;
  obInfoLoaded = true;
  try {
    const p = api.appInfo ? api.appInfo() : null;
    if (p && p.then) {
      p.then((info) => {
        obUser = obHumanName(info && info.user);
        obPersonalize();
      }).catch(() => {});
    }
  } catch {}
}

function obPersonalize() {
  obLoadUser();
  const title = document.getElementById('ob-title');
  if (title && obUser) title.textContent = 'Здравствуйте, ' + obUser + '!';
}

// Показываем то устройство, которое реально будет использоваться, а не первое
// попавшееся. Приоритет: VB-CABLE → Sonar → VoiceMeeter → любое виртуальное.
// Это важно: если установлен CABLE, мастер не должен писать про «Стерео микшер».
function obVirtualMic() {
  const outs = devices || [];
  const ins = micInputs || [];

  // 0) Если пользователь уже выбрал виртуальное устройство — показываем ИМЕННО его.
  //    Это главное правило: никаких «первый подходящий», никакого навязанного Sonar.
  const selected = virtualRouteFor(config.outputDevice);
  if (selected) return selected;

  const cableIn = outs.find((d) => /cable/i.test(d.label) && /input/i.test(d.label))
    || outs.find((d) => /cable|vb-?audio/i.test(d.label));
  if (cableIn) {
    const cableOut = ins.find((d) => /cable/i.test(d.label) && /output/i.test(d.label))
      || ins.find((d) => /cable/i.test(d.label))
      || null;
    return { outLabel: cableIn.label, label: cableOut ? cableOut.label : 'CABLE Output', mode: 'cable' };
  }

  const sonarOut = outs.find((d) => /sonar/i.test(d.label) && /microphone|микрофон/i.test(d.label))
    || outs.find((d) => /sonar/i.test(d.label) && /media|gaming|chat|aux/i.test(d.label));
  if (sonarOut) {
    const sonarIn = ins.find((d) => /sonar/i.test(d.label) && /stream/i.test(d.label))
      || ins.find((d) => /sonar/i.test(d.label) && /microphone|микрофон/i.test(d.label))
      || null;
    return { outLabel: sonarOut.label, label: sonarIn ? sonarIn.label : sonarOut.label, mode: 'sonar' };
  }

  const vmOut = outs.find((d) => /voicemeeter/i.test(d.label));
  if (vmOut) {
    const vmIn = ins.find((d) => /voicemeeter/i.test(d.label)) || null;
    return { outLabel: vmOut.label, label: vmIn ? vmIn.label : vmOut.label, mode: 'voicemeeter' };
  }

  const any = outs.concat(ins).find((d) => isVirtualMicLabel(d.label));
  return any ? { outLabel: any.label, label: any.label, mode: 'other' } : null;
}

async function obCheckVirtualMic() {
  const box = document.getElementById('ob-vb-status');
  const title = document.getElementById('ob-vb-title');
  const sub = document.getElementById('ob-vb-sub');
  const btn = document.getElementById('ob-vb-install');
  const have = document.getElementById('ob-vb-have');
  if (!box || !title || !sub) return;
  const found = obVirtualMic();
  const ok = !!found;
  box.classList.toggle('ok', ok);
  box.classList.toggle('warn', !ok);
  title.textContent = ok ? 'У тебя уже есть виртуальный микрофон' : 'Виртуального микрофона пока нет';
  sub.textContent = ok
    ? (found.label || 'устройство') + ' — ничего скачивать не нужно'
    : 'Поставим VB-CABLE — это бесплатно и займёт минуту';
  if (btn) {
    btn.textContent = ok ? 'Скачать VB-CABLE' : 'Скачать VB-CABLE';
    btn.style.display = ok ? 'none' : '';
  }
  if (have) have.style.display = ok ? 'none' : '';
  obUpdateRouteName();
  obPersonalize();
}

function obUpdateRouteName() {
  const el = document.getElementById('ob-route-name');
  if (!el) return;
  const found = obVirtualMic();
  // Никаких выдуманных имён: если устройства нет — честно пишем «виртуальный микрофон».
  let name = found ? (found.label || '') : '';
  if (!name) name = 'виртуальный микрофон';
  // длинные названия драйверов оставляем читаемыми
  if (name.length > 44) name = name.slice(0, 42).trim() + '…';
  el.textContent = name;
}

function obFillDevices() {
  const outSel = document.getElementById('ob-out-device');
  const spkSel = document.getElementById('ob-spk-device');
  if (!outSel || !spkSel) return;
  const found = obVirtualMic();
  const defMic = found && found.outId ? found.outId : '';
  const fill = (sel, list, current, defLabel) => {
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = defLabel;
    sel.appendChild(def);
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label || 'Устройство';
      if (d.id === current) o.selected = true;
      sel.appendChild(o);
    }
    if (!list.some((d) => d.id === current)) sel.value = '';
  };
  const isVirt = (l) => /cable|vb-audio|sonar|voicemeeter|virtual|стерео\s*микшер|stereo\s*mix/i.test(l || '');
  const outs = (devices || []).slice().sort((a, b) => (isVirt(a.label) ? 0 : 1) - (isVirt(b.label) ? 0 : 1));
  const spks = (devices || []).slice().sort((a, b) => (isVirt(a.label) ? 1 : 0) - (isVirt(b.label) ? 1 : 0));
  fill(outSel, outs, config.outputDevice || defMic, 'Не выбрано (системный выход)');
  fill(spkSel, spks, config.speakerDevice, 'Динамики по умолчанию');
  if (!config.outputDevice && defMic) {
    config.outputDevice = defMic;
    config._noAutoMic = true;
    engine.setMicDevice(defMic);
    saveConfig();
  }
  // подпись с реальными устройствами, чтобы не было «шаблона»
  const note = document.getElementById('ob-dev-note');
  if (note) {
    const micTxt = found ? (found.outLabel || 'виртуальный микрофон') : 'не найден';
    const spkTxt = deviceLabel(config.speakerDevice) || 'по умолчанию';
    note.innerHTML = 'Сейчас в системе: <b>' + escapeHtml(micTxt) + '</b> → для звуков, ' +
      '<b>' + escapeHtml(spkTxt) + '</b> → для тебя.<br>Поменять можно в любой момент: <b>Настройки → Устройства</b>.';
  }
  obUpdateRouteName();
}

// ---- интерактивные горячие клавиши: пользователь сам пробует префикс ----
let obKeyArmedUntil = 0;
let obKeyResetTimer = 0;

function obKeyChipEl(label, mod, hit) {
  const el = document.createElement('span');
  el.className = 'ob-key' + (mod ? ' mod' : '') + (hit ? ' hit' : '');
  el.textContent = label;
  return el;
}

function obPrefixKey() {
  return config.prefixKey || '\\';
}

function obPrefixLabel(k) {
  if (k === ' ') return 'Space';
  if (k === 'Escape') return 'Esc';
  return k;
}

function obKeyName(e) {
  // Клавишу берём по физическому коду: на русской раскладке e.key — кириллица,
  // а хоткеи в приложении привязаны к физическим клавишам.
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (code === 'Backslash' || code === 'IntlBackslash') return '\\';
  const k = e.key;
  if (!k) return '';
  if (k === 'Control') return 'Ctrl';
  if (k === 'Meta') return 'Win';
  if (k === ' ') return 'Space';
  if (k === 'Escape') return 'Esc';
  if (k.length === 1) return k.toUpperCase();
  return k;
}

function obIsPrefix(e) {
  const p = obPrefixKey();
  const key = (e.key || '').toLowerCase();
  if (key && key === p.toLowerCase()) return true;
  // физическая клавиша: работает независимо от раскладки
  if (p === '\\' && (e.code === 'Backslash' || e.code === 'IntlBackslash')) return true;
  if (/^[a-z]$/i.test(p) && e.code === 'Key' + p.toUpperCase()) return true;
  if (/^[0-9]$/.test(p) && e.code === 'Digit' + p) return true;
  return false;
}

function obBindHotkeyDemo() {
  const slide = document.querySelector('#onboard .ob-slide[data-hotkeys="1"]');
  if (!slide || slide.dataset.keyDemo) return;
  slide.dataset.keyDemo = '1';
  const live = document.getElementById('ob-keys-live');
  const status = document.getElementById('ob-keys-status');
  if (!live || !status) return;

  const prefixNow = () => obPrefixLabel(obPrefixKey());
  const paintPrefixLabels = () => {
    document.querySelectorAll('#onboard [data-prefix]').forEach((el) => {
      el.textContent = prefixNow();
    });
  };
  paintPrefixLabels();

  const setStatus = (text, cls) => {
    status.textContent = text;
    status.className = 'ob-try-status' + (cls ? ' ' + cls : '');
  };

  const paintCombo = (prefix, key) => {
    live.innerHTML = '';
    if (prefix != null) live.appendChild(obKeyChipEl(prefix, true, true));
    if (key) {
      if (prefix != null) {
        const plus = document.createElement('span');
        plus.className = 'ob-plus';
        plus.textContent = '+';
        live.appendChild(plus);
      }
      live.appendChild(obKeyChipEl(key, true, true));
    }
  };

  const reset = () => {
    obKeyArmedUntil = 0;
    live.innerHTML = '<span class="ob-live-none">Здесь появятся твои клавиши</span>';
    setStatus('Жду нажатия…', '');
  };

  document.addEventListener('keydown', (e) => {
    if (!obOpen) return;
    if (!slide.classList.contains('active')) return;
    const root = document.getElementById('onboard');
    if (!root || root.classList.contains('hidden')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // чистые модификаторы не считаем клавишей песни (если префикс не они)
    if (/^(Control|Alt|Shift|Meta)$/.test(e.key) && !obIsPrefix(e)) return;
    e.preventDefault();
    paintPrefixLabels();

    const key = obKeyName(e);
    const now = Date.now();

    if (obIsPrefix(e)) {
      obKeyArmedUntil = now + 5000;
      paintCombo(prefixNow(), '');
      setStatus('Префикс нажат — теперь жми клавишу песни', 'wait');
      clearTimeout(obKeyResetTimer);
      obKeyResetTimer = setTimeout(() => {
        if (Date.now() > obKeyArmedUntil) reset();
      }, 5200);
      return;
    }

    if (now <= obKeyArmedUntil) {
      paintCombo(prefixNow(), key);
      setStatus('Сработало: ' + prefixNow() + ' + ' + key + ' — песня включилась!', 'ok');
      try { uiSound('success'); } catch {}
      obKeyArmedUntil = 0;
      clearTimeout(obKeyResetTimer);
      obKeyResetTimer = setTimeout(reset, 4500);
    } else {
      paintCombo(null, key);
      setStatus('Сначала нажми префикс ' + prefixNow(), 'wait');
    }
  });
}

function initOnboardVideos() {
  const vids = Array.from(document.querySelectorAll('#onboard .ob-video video'));
  vids.forEach((v) => {
    v.loop = true;
    v.playsInline = true;
    // Ролики звучат, но играет только активный. Кнопки звука нет — включаем сразу.
    v.muted = false;
    v.volume = 0.8;
    v.preload = 'none';

    const box = v.closest('.ob-video');
    const markReady = () => { if (box) box.classList.add('ready'); };
    if (v.readyState >= 1) markReady();
    v.addEventListener('loadeddata', markReady);
    v.addEventListener('canplay', markReady);

    v.addEventListener('error', () => {
      if (box) box.classList.remove('ready');
      const slide = v.closest('.ob-slide');
      if (!v.getAttribute('src')) return;
      if (slide && slide.classList.contains('active') && obOpen) {
        setTimeout(() => { try { v.load(); } catch {} }, 500);
      }
    });

    // Клик по ролику — пауза/продолжить.
    v.addEventListener('click', () => {
      if (v.paused) obPlayVideo(v);
      else { try { v.pause(); } catch {} }
    });

    // Страховка от наложения звука: если неактивный ролик всё же начал
    // играть (например, из-за отложенного play()), мгновенно ставим паузу.
    v.addEventListener('playing', () => {
      const slide = v.closest('.ob-slide');
      if (!obOpen || !slide || !slide.classList.contains('active')) {
        try { v.pause(); } catch {}
      }
    });

    // Кнопка «развернуть», как на YouTube, но в стиле SoundPulse.
    if (box && !box.querySelector('.ob-expand')) {
      const btn = document.createElement('button');
      btn.className = 'ob-expand';
      btn.type = 'button';
      btn.title = 'Развернуть';
      btn.setAttribute('aria-label', 'Развернуть видео');
      btn.innerHTML = '<svg class="ic"><use href="#i-expand"/></svg>';
      btn.addEventListener('click', (e) => { e.stopPropagation(); obOpenTheater(v); });
      box.appendChild(btn);
    }
  });

  const th = document.getElementById('ob-theater');
  const thClose = document.getElementById('ob-theater-close');
  const thVideo = document.getElementById('ob-theater-video');
  if (th && !th.dataset.bound) {
    th.dataset.bound = '1';
    th.addEventListener('click', (e) => { if (e.target === th) obCloseTheater(); });
  }
  if (thClose && !thClose.dataset.bound) {
    thClose.dataset.bound = '1';
    thClose.addEventListener('click', obCloseTheater);
  }
  if (thVideo && !thVideo.dataset.bound) {
    thVideo.dataset.bound = '1';
    thVideo.addEventListener('click', () => {
      if (thVideo.paused) { try { thVideo.play().catch(() => {}); } catch {} }
      else { try { thVideo.pause(); } catch {} }
    });
  }

  obBindSoundUnlock();
  obBindHotkeyDemo();
  obSyncVideos();
}


function obPlayVideo(v) {
  if (!v || !obOpen) return;
  // Ролик без источника не запускаем: play() на пустом <video> висит
  // в состоянии «играет» вечно и не даёт потом корректно освободить элемент.
  if (!v.hasAttribute('src') && !v.currentSrc) return;
  try { v.muted = false; v.volume = 0.8; } catch {}
  let p;
  try { p = v.play(); } catch { return; }
  if (p && p.catch) {
    // Если система всё же запретила автозвук — показываем ролик без звука,
    // а звук включится после первого клика/нажатия (см. обработчик ниже).
    p.catch(() => {
      try {
        v.muted = true;
        const p2 = v.play();
        if (p2 && p2.catch) p2.catch(() => {});
      } catch {}
    });
  }
}

// Один раз на первое действие пользователя снимаем mute с активного ролика:
// так звук появляется даже если браузер заблокировал озвученный автоплей.
function obBindSoundUnlock() {
  if (document.body.dataset.obSoundUnlock) return;
  document.body.dataset.obSoundUnlock = '1';
  const unlock = () => {
    document.querySelectorAll('#onboard .ob-slide.active video').forEach((v) => {
      if (v.muted) {
        v.muted = false;
        v.volume = 0.8;
        if (v.paused && obOpen) obPlayVideo(v);
      }
    });
    const tv = document.getElementById('ob-theater-video');
    if (tv && !tv.paused) tv.muted = false;
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

// Играем только ролик текущего экрана. Остальные не грузим и держим на паузе:
// именно из-за autoplay в фоне раньше звучала «какофония» всех видео сразу.
// Освобождаем декодер и буферы неактивных роликов: без этого к концу
// обучения в памяти висят все 19 видео (по несколько сотен МБ) и приложение
// начинает лагать. src запоминаем в data-src, чтобы вернуть при переходе назад.
function obVidSrc(v) {
  if (!v.dataset.src) v.dataset.src = v.getAttribute('src') || '';
  return v.dataset.src;
}

function obVidRelease(v) {
  try {
    if (!v.paused) v.pause();
    if (v.hasAttribute('src')) v.removeAttribute('src');
    v.preload = 'none';
    if (v.networkState !== 0) v.load();
    // отменённый на полпути play() может оставить флаг «играет» —
    // ставим паузу повторно уже без источника
    if (!v.paused) v.pause();
    const box = v.closest('.ob-video');
    if (box) box.classList.remove('ready');
  } catch {}
}

function obSyncVideos() {
  const root = document.getElementById('onboard');
  const open = !!(root && !root.classList.contains('hidden') && obOpen);
  const slides = Array.from(document.querySelectorAll('#onboard .ob-slide'));
  const active = slides.findIndex((s) => s.classList.contains('active'));
  slides.forEach((slide, i) => {
    const dist = active < 0 ? 99 : Math.abs(i - active);
    // держим в памяти только текущий ролик и соседние (для быстрого перехода)
    const keep = open && dist <= 1;
    slide.querySelectorAll('video').forEach((v) => {
      const src = obVidSrc(v);
      if (!src) return;
      try {
        if (!keep) { obVidRelease(v); return; }
        if (!v.hasAttribute('src')) {
          v.setAttribute('src', src);
          v.preload = 'auto';
          v.load();
        }
        if (i === active) {
          if (v.preload !== 'auto') v.preload = 'auto';
          if (v.readyState >= 1) { try { v.currentTime = 0; } catch {} }
          obPlayVideo(v);
        } else {
          // Соседний ролик держим загруженным, но ОБЯЗАТЕЛЬНО на паузе:
          // иначе звук предыдущего слайда продолжает играть поверх нового
          // и ролики накладываются друг на друга.
          if (!v.paused) { try { v.pause(); } catch {} }
          if (v.networkState === 0) {
            v.preload = 'auto';
            try { v.load(); } catch {}
          }
        }
      } catch {}
    });
  });
  if (open) { initObParticles(); obParticlesStart(); }
  else obParticlesStop();
}

// ---- полноэкранный просмотр ролика ----
let obTheaterSource = null;
function obOpenTheater(v) {
  if (!v) return;
  const box = document.getElementById('ob-theater');
  const tv = document.getElementById('ob-theater-video');
  if (!box || !tv) return;
  const src = v.currentSrc || v.src;
  if (!src) return;
  obTheaterSource = v;
  if (!v.paused) { try { v.pause(); } catch {} }
  tv.src = src;
  tv.muted = false;
  tv.volume = 0.9;
  tv.loop = true;
  tv.preload = 'auto';
  try { tv.currentTime = v.currentTime || 0; } catch {}
  box.classList.remove('hidden', 'closing');
  const card = document.getElementById('ob-card');
  if (card) card.classList.add('theatering');
  try { tv.play().catch(() => {}); } catch {}
}

function obCloseTheater() {
  const box = document.getElementById('ob-theater');
  const tv = document.getElementById('ob-theater-video');
  if (!box || box.classList.contains('hidden') || box.classList.contains('closing')) return;
  box.classList.add('closing');
  const card = document.getElementById('ob-card');
  if (card) card.classList.remove('theatering');
  const src = obTheaterSource;
  obTheaterSource = null;
  setTimeout(() => {
    box.classList.add('hidden');
    box.classList.remove('closing');
    if (tv) {
      try { tv.pause(); tv.removeAttribute('src'); tv.load(); } catch {}
    }
    // возвращаем ролик на слайде, если он всё ещё на экране
    if (src && obOpen && src.closest('.ob-slide') && src.closest('.ob-slide').classList.contains('active')) {
      obPlayVideo(src);
    }
  }, 210);
}

// ---- частицы на фоне ----
let obParticlesCtx = null;
let obParticlesDots = [];
let obParticlesW = 0;
let obParticlesH = 0;
let obParticlesRaf = 0;
let obParticlesReduced = false;

function initObParticles() {
  const c = document.getElementById('ob-particles');
  if (!c || c.dataset.ready) return;
  const rect = c.getBoundingClientRect();
  // пока мастер скрыт, canvas имеет нулевой размер — подождём, пока он появится
  if (rect.width < 2 || rect.height < 2) return;
  c.dataset.ready = '1';
  obParticlesCtx = c.getContext('2d');
  if (!obParticlesCtx) return;
  obParticlesReduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const resize = () => {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    obParticlesW = Math.max(1, r.width);
    obParticlesH = Math.max(1, r.height);
    c.width = Math.round(obParticlesW * dpr);
    c.height = Math.round(obParticlesH * dpr);
    obParticlesCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = obParticlesReduced ? 26 : Math.max(30, Math.min(80, Math.round(obParticlesW * obParticlesH / 24000)));
    obParticlesDots = Array.from({ length: n }, () => ({
      x: Math.random() * obParticlesW,
      y: Math.random() * obParticlesH,
      r: 0.7 + Math.random() * 1.9,
      vx: (Math.random() - 0.5) * 0.22,
      vy: ((Math.random() - 0.5) * 0.22) - 0.05,
      a: 0.12 + Math.random() * 0.36,
      ph: Math.random() * Math.PI * 2,
    }));
    if (obParticlesReduced) obParticlesRender(0);
  };
  resize();
  window.addEventListener('resize', resize);
  obParticlesStart();
}

function obParticlesRender(t) {
  const ctx = obParticlesCtx;
  if (!ctx) return;
  ctx.clearRect(0, 0, obParticlesW, obParticlesH);
  for (const d of obParticlesDots) {
    const tw = 0.72 + Math.sin(t / 900 + d.ph) * 0.28;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(125,190,255,' + (d.a * tw).toFixed(3) + ')';
    ctx.fill();
  }
}

function obParticlesFrame(t) {
  const root = document.getElementById('onboard');
  if (!root || root.classList.contains('hidden') || !obOpen || document.hidden) {
    obParticlesRaf = 0;
    return;
  }
  for (const d of obParticlesDots) {
    d.x += d.vx; d.y += d.vy;
    if (d.x < -12) d.x = obParticlesW + 12;
    if (d.x > obParticlesW + 12) d.x = -12;
    if (d.y < -12) d.y = obParticlesH + 12;
    if (d.y > obParticlesH + 12) d.y = -12;
  }
  obParticlesRender(t);
  obParticlesRaf = requestAnimationFrame(obParticlesFrame);
}

function obParticlesStart() {
  if (obParticlesReduced || obParticlesRaf || !obParticlesCtx) return;
  obParticlesRaf = requestAnimationFrame(obParticlesFrame);
}

function obParticlesStop() {
  if (obParticlesRaf) { cancelAnimationFrame(obParticlesRaf); obParticlesRaf = 0; }
}

window.openOnboarding = function () {
  config.onboarded = false;
  config.tourDone = false;
  config.onboardingRev = 0;
  initOnboarding();
  const root = document.getElementById('onboard');
  if (!root) return;
  obOpen = true;
  root.classList.remove('hidden');
  obShow(0);
  obCheckVirtualMic();
  obFillDevices();
  obPersonalize();
  if (window.SPGlass) window.SPGlass.refresh();
};


// ---- v6.0: спецэффекты действий (рябь на кнопках, вспышка на карточке) ----
// Делегирование: один слушатель на весь документ, никаких правок в разметке.
function setupMotionEffects() {
  document.addEventListener('pointerdown', (e) => {
    if (config.anims === false || e.button !== 0) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const card = t.closest('.sound');
    if (card) {
      card.classList.remove('hit');
      void card.offsetWidth;
      card.classList.add('hit');
      clearTimeout(card._hitTimer);
      card._hitTimer = setTimeout(() => card.classList.remove('hit'), 460);
    }
    const btn = t.closest('.btn,.fbtn,.small-btn,.side-btn,.new-set');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    if (!r.width) return;
    const size = Math.max(r.width, r.height) * 2;
    const sp = document.createElement('span');
    sp.className = 'ripple';
    sp.style.width = size + 'px';
    sp.style.height = size + 'px';
    sp.style.left = (e.clientX - r.left - size / 2) + 'px';
    sp.style.top = (e.clientY - r.top - size / 2) + 'px';
    btn.appendChild(sp);
    setTimeout(() => sp.remove(), 640);
  }, { passive: true });
}

setupMotionEffects();
init();

// ---- фоновое сияние: рисуем рассеянные лучи один раз в Canvas (CPU-фри) ----
// Полотно рисуется с массивом по краям и двигается transform-ом (дешёво для GPU).
const AUR_PAD = 160;
function renderAurora() {
  const aur = document.getElementById('aurora');
  if (!aur) return;
  let cv = aur.querySelector('canvas.aurora-bg');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = 'aurora-bg';
    cv.style.cssText = 'position:absolute;z-index:-1;pointer-events:none;will-change:transform;';
    aur.appendChild(cv);
  }
  const cw = aur.clientWidth + AUR_PAD * 2, ch = aur.clientHeight + AUR_PAD * 2;
  cv.style.left = (-AUR_PAD) + 'px'; cv.style.top = (-AUR_PAD) + 'px';
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  if (!cv._ok && (cw < 10 || ch < 10)) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const g = cv.getContext('2d');
  g.save(); g.scale(dpr, dpr); g.clearRect(0, 0, cw, ch);
  if ('filter' in g) g.filter = 'blur(34px)';
  const W = cw, H = ch;
  let b1 = g.createLinearGradient(0, 0, W * 0.55, 0);
  b1.addColorStop(0, 'rgba(120,180,255,0)');
  b1.addColorStop(.32, 'rgba(120,180,255,.18)');
  b1.addColorStop(.6, 'rgba(62,128,255,.24)');
  b1.addColorStop(1, 'rgba(34,84,210,0)');
  g.save(); g.translate(W * 0.30, -H * 0.16); g.rotate(0.13);
  g.fillStyle = b1; g.fillRect(-W * 0.4, -H * 0.1, W * 1.2, H * 1.3); g.restore();
  let b2 = g.createLinearGradient(0, 0, W * 0.5, 0);
  b2.addColorStop(0, 'rgba(120,180,255,0)');
  b2.addColorStop(.34, 'rgba(120,180,255,.16)');
  b2.addColorStop(.62, 'rgba(62,128,255,.22)');
  b2.addColorStop(1, 'rgba(34,84,210,0)');
  g.save(); g.translate(W * 0.85, H * 1.18); g.rotate(0.13);
  g.fillStyle = b2; g.fillRect(-W * 0.4, -H * 0.1, W * 1.2, H * 1.3); g.restore();
  const glow = (x, y, r, a) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(96,158,255,' + a + ')');
    rg.addColorStop(1, 'rgba(96,158,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  };
  glow(W * 0.12, H * 0.30, W * 0.32, 0.17);
  glow(W * 0.90, H * 0.72, W * 0.36, 0.14);
  cv._ok = true;
  if ('filter' in g) g.filter = 'none';
  g.restore();
}
let rT = null;
// фон рисуем после первого кадра: градиенты на весь экран не должны
// задерживать появление интерфейса
requestAnimationFrame(() => setTimeout(renderAurora, 60));
window.addEventListener('resize', () => {
  if (rT) clearTimeout(rT);
  rT = setTimeout(renderAurora, 220);
});

if (location.hash === '#test') {
  window.__sp = {
    get config() { return config; },
    sounds,
    engine,
    devices,
    initState: () => ({ cfg: config.sounds.length, map: sounds.size, master: config.masterVolume }),
    playSound,
    stopAll,
    addSoundFiles,
    removeSound: (id) => { deleteSound(id); if (hideContextMenu) hideContextMenu(); },
    refreshDevices,
    prettyHotkey
  };
}


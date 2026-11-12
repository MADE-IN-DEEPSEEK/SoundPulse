const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (e, payload) => cb(payload));

contextBridge.exposeInMainWorld('soundpad', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  windowControls: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    hide: () => ipcRenderer.invoke('win:hide'),
    quit: () => ipcRenderer.invoke('win:quit'),
    onCloseRequested: (cb) => on('win:close-requested', cb)
  },
  storeGet: () => ipcRenderer.invoke('store:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  librarySave: (data) => ipcRenderer.invoke('library:save', data),
  hotkeysSet: (map) => ipcRenderer.invoke('hotkeys:set', map),
  specialHotkeysSet: (map) => ipcRenderer.invoke('special-hotkeys:set', map),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),
  suppressHotkeys: (b) => ipcRenderer.invoke('hotkeys:suppress', b),
  listExport: (sounds) => ipcRenderer.invoke('list:export', sounds),
  listLoad: () => ipcRenderer.invoke('list:load'),
  pickSounds: () => ipcRenderer.invoke('dialog:pickSounds'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  folderScan: (dir) => ipcRenderer.invoke('folder:scan', dir),
  fsRead: (p) => ipcRenderer.invoke('fs:read', p),
  fsReadHead: (p, max) => ipcRenderer.invoke('fs:readHead', p, max),
  fsStat: (p) => ipcRenderer.invoke('fs:stat', p),
  recordingSave: (buf, name) => ipcRenderer.invoke('recording:save', buf, name),
  documentsOpen: (which) => ipcRenderer.invoke('documents:open', which),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  webDownload: (url) => ipcRenderer.invoke('web:download', url),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  debug: (msg) => ipcRenderer.invoke('app:debug', msg),

  onHotkey: (cb) => on('hotkey', cb),
  onHotkeyError: (cb) => on('hotkey-error', cb),
  onSettingsChanged: (cb) => on('settings:changed', cb),
  // окно ушло в трей / вернулось — интерфейс можно «заморозить», звук при этом живёт
  onTrayMode: (cb) => on('win:tray-mode', cb)
});
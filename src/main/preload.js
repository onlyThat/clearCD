'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 只暴露白名单通道，渲染进程拿不到 ipcRenderer 本体 */
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /* 环境 */
  envInfo: () => ipcRenderer.invoke('env:info'),
  getDrives: () => ipcRenderer.invoke('drives:get'),
  elevate: () => ipcRenderer.invoke('admin:elevate'),

  /* 窗口按钮 */
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  onMaxState: (cb) => on('win:maxstate', cb),

  /* 扫描 */
  startScan: (opts) => ipcRenderer.invoke('scan:start', opts),
  stopScan: () => ipcRenderer.invoke('scan:stop'),
  onScanProgress: (cb) => on('scan:progress', cb),
  onScanItem: (cb) => on('scan:item', cb),
  onScanDone: (cb) => on('scan:done', cb),

  /* 清理 */
  clean: (ids, opts) => ipcRenderer.invoke('clean:run', ids, opts),
  onCleanProgress: (cb) => on('clean:progress', cb),

  /* 大文件 */
  findBigFiles: (opts) => ipcRenderer.invoke('files:findBig', opts),
  onBigFileProgress: (cb) => on('bigfile:progress', cb),
  trashFiles: (paths) => ipcRenderer.invoke('files:trash', paths),

  /* 系统 */
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
});
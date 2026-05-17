// preload.js
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('electronLog', {
    info: (msg) => ipcRenderer.invoke('log-info', msg),
    error: (msg) => ipcRenderer.invoke('log-error', msg),
});
contextBridge.exposeInMainWorld('electronAPI', {
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    // 监听主进程的退出请求
    onQuitRequest: (callback) => ipcRenderer.on('app-quit-request', callback),
    // 通知主进程可以退出
    quitConfirmed: () => ipcRenderer.send('quit-confirmed'),
    // 弹窗提示
    showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
    showPrompt: (options) => ipcRenderer.invoke('show-prompt', options),
    showConfirmBox: (options) => ipcRenderer.invoke('show-confirm-box', options),
    getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'), // 默认输出目录
    //     获取机器码
    getMachineCode: () => ipcRenderer.invoke('get-machine-code'),
    getElectronToken: () => ipcRenderer.invoke('get-electron-token'),//获取token
    // 更新进度监听
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', callback),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
    onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
});

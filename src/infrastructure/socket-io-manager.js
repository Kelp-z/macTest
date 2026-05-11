// src/infrastructure/socket-io-manager.js
let globalIo = null;

/**
 * 设置全局 Socket.IO 实例
 */
function setIo(io) {
    globalIo = io;
}

/**
 * 获取全局 Socket.IO 实例
 */
function getIo() {
    return globalIo;
}

/**
 * 检查 Socket.IO 是否已初始化
 */
function isIoInitialized() {
    return globalIo !== null && globalIo !== undefined;
}

module.exports = {
    setIo,
    getIo,
    isIoInitialized
};

// common-utils.js - 纯工具函数
const path = require('path');
const fs = require('fs');

/**
 * 格式化日期为 yyyy-MM-dd HH:mm:ss
 */
function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 计算两个字符串的相似度（基于三元组匹配）
 */
function calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0.0;
    const shorter = str1.length <= str2.length ? str1.toLowerCase() : str2.toLowerCase();
    const longer = str1.length > str2.length ? str1.toLowerCase() : str2.toLowerCase();

    let matches = 0;
    for (let i = 0; i < shorter.length - 2; i++) {
        const substr = shorter.substring(i, i + 3);
        if (longer.includes(substr)) matches++;
    }
    return Math.min(1.0, matches / Math.max(1, shorter.length / 3));
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * 递归检查目录是否为空
 */
function isDirectoryEmpty(dirPath) {
    if (!fs.existsSync(dirPath)) return true;
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            if (!isDirectoryEmpty(fullPath)) return false;
        } else {
            return false;
        }
    }
    return true;
}

/**
 * 清理空目录
 */
function cleanEmptyDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    if (isDirectoryEmpty(dirPath)) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log(`已删除空目录: ${dirPath}`);
        } catch (err) {
            console.warn(`删除空目录失败: ${err.message}`);
        }
    }
}

module.exports = {
    formatDateTime,
    calculateStringSimilarity,
    ensureDir,
    isDirectoryEmpty,
    cleanEmptyDirectory
};

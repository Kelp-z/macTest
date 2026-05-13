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
/**
 * 清理验证码临时目录
 * @param {string} captchaDirName - 验证码目录名称（默认 'captcha_temp'）
 * @param {Object} logger - 日志对象（可选，默认使用 console）
 * @returns {Object} 清理结果 { deletedCount, totalSize, success }
 */
function cleanupCaptchaDir(captchaDirName = 'captcha_temp', logger = null) {
    const log = logger || console;

    try {
        const captchaDir = path.join(process.cwd(), captchaDirName);

        if (!fs.existsSync(captchaDir)) {
            if (log.debug) log.debug(`验证码目录不存在: ${captchaDir}`);
            return { deletedCount: 0, totalSize: 0, success: true };
        }

        // 读取目录内容
        const files = fs.readdirSync(captchaDir);
        let deletedCount = 0;
        let totalSize = 0;

        for (const file of files) {
            const filePath = path.join(captchaDir, file);

            try {
                const stats = fs.statSync(filePath);

                // 只删除文件，不删除子目录
                if (stats.isFile()) {
                    totalSize += stats.size;
                    fs.unlinkSync(filePath);
                    deletedCount++;
                } else if (stats.isDirectory()) {
                    // 递归删除子目录中的所有文件
                    const subResult = _cleanupDirectoryRecursive(filePath, log);
                    deletedCount += subResult.deletedCount;
                    totalSize += subResult.totalSize;

                    // 如果子目录为空，删除子目录
                    const remainingFiles = fs.readdirSync(filePath);
                    if (remainingFiles.length === 0) {
                        fs.rmdirSync(filePath);
                        if (log.debug) log.debug(`已删除空子目录: ${file}`);
                    }
                }
            } catch (err) {
                if (log.warn) log.warn(`无法删除文件 ${file}: ${err.message}`);
            }
        }

        if (deletedCount > 0) {
            const sizeKB = (totalSize / 1024).toFixed(2);
            const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
            const sizeStr = totalSize > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

            if (log.info) log.info(`已清理验证码目录: 删除 ${deletedCount} 个文件，释放 ${sizeStr}`);
        } else {
            if (log.debug) log.debug('验证码目录为空，无需清理');
        }

        return {
            deletedCount,
            totalSize,
            success: true
        };

    } catch (error) {
        if (logger && logger.error) {
            logger.error(`清理验证码目录失败: ${error.message}`);
        } else {
            console.error(`清理验证码目录失败: ${error.message}`);
        }
        return {
            deletedCount: 0,
            totalSize: 0,
            success: false
        };
    }
}

/**
 * 递归清理目录中的所有文件（内部辅助函数）
 * @private
 */
function _cleanupDirectoryRecursive(dirPath, log) {
    let deletedCount = 0;
    let totalSize = 0;

    try {
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
            const filePath = path.join(dirPath, file);

            try {
                const stats = fs.statSync(filePath);

                if (stats.isFile()) {
                    totalSize += stats.size;
                    fs.unlinkSync(filePath);
                    deletedCount++;
                } else if (stats.isDirectory()) {
                    const subResult = _cleanupDirectoryRecursive(filePath, log);
                    deletedCount += subResult.deletedCount;
                    totalSize += subResult.totalSize;

                    // 删除空子目录
                    const remainingFiles = fs.readdirSync(filePath);
                    if (remainingFiles.length === 0) {
                        fs.rmdirSync(filePath);
                    }
                }
            } catch (err) {
                if (log.warn) log.warn(`无法删除 ${filePath}: ${err.message}`);
            }
        }
    } catch (error) {
        if (log.warn) log.warn(`无法读取目录 ${dirPath}: ${error.message}`);
    }

    return { deletedCount, totalSize };
}

module.exports = {
    formatDateTime,
    calculateStringSimilarity,
    cleanupCaptchaDir,
    ensureDir,
    isDirectoryEmpty,
    cleanEmptyDirectory
};

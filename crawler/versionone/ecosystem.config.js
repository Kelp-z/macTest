// ecosystem.config.js
module.exports = {
    apps: [{
        name: "scholar-server", // 服务名称
        script: "scholar-server.js", // 入口文件
        instances: 1, // 启动1个实例（多核可设为"max"）
        exec_mode: "fork", // 单进程模式（适合爬虫，避免浏览器冲突）
        env: {
            NODE_ENV: "production", // 生产环境
        },
        // 重启规则
        autorestart: true, // 崩溃后自动重启
        restart_delay: 3000, // 崩溃后延迟3秒重启
        max_restarts: 10, // 1分钟内最多重启10次（避免无限重启）
        // 日志配置（关键：记录所有输出，便于排查问题）
        log_date_format: "YYYY-MM-DD HH:mm:ss",
        out_file: "./logs/out.log", // 正常日志
        error_file: "./logs/error.log", // 错误日志
        merge_logs: true, // 合并日志
        // 监控配置
        watch: false, // 生产环境关闭文件监听（避免误重启）
        ignore_watch: ["node_modules", "logs", "browsers"], // 忽略监控的目录
        // 资源限制（避免内存泄漏）
        max_memory_restart: "1G", // 内存超过1GB时自动重启
    }]
};

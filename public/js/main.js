// DOM 元素
const startBtn = document.getElementById('startBtn');
const targetUrl = document.getElementById('targetUrl');
const pageNum = document.getElementById('pageNum');
const isRunning = document.getElementById('isRunning');
const progress = document.getElementById('progress');
const progressText = document.getElementById('progressText');
const errorMsg = document.getElementById('errorMsg');
const resultBody = document.getElementById('resultBody');

// 启动爬虫按钮点击事件
startBtn.addEventListener('click', async () => {
    try {
        // 禁用按钮，避免重复点击
        startBtn.disabled = true;
        startBtn.textContent = '启动中...';
        errorMsg.textContent = '';
        resultBody.innerHTML = '';

        // 调用后端接口启动爬虫
        await axios.post('/api/crawler/start', {
            targetUrl: targetUrl.value.trim(),
            pageNum: parseInt(pageNum.value)
        });

        // 启动轮询，获取爬虫状态
        pollCrawlerStatus();

    } catch (err) {
        errorMsg.textContent = err.response?.data?.msg || '启动失败';
        startBtn.disabled = false;
        startBtn.textContent = '启动爬虫';
    }
});

// 轮询爬虫状态（每500ms查询一次）
function pollCrawlerStatus() {
    const timer = setInterval(async () => {
        try {
            const res = await axios.get('/api/crawler/status');
            const { isRunning: status, progress: p, result, error } = res.data.data;

            // 更新状态展示
            isRunning.textContent = status ? '运行中' : '已停止';
            progress.value = p;
            progressText.textContent = `${p}%`;
            errorMsg.textContent = error || '';

            // 渲染爬取结果
            if (result.length > 0) {
                resultBody.innerHTML = result.map(item => `
          <tr>
            <td>${item.page}</td>
            <td>${item.title}</td>
            <td><a href="${item.href}" target="_blank">${item.href}</a></td>
          </tr>
        `).join('');
            }

            // 爬虫停止后，停止轮询，恢复按钮
            if (!status) {
                clearInterval(timer);
                startBtn.disabled = false;
                startBtn.textContent = '启动爬虫';
            }

        } catch (err) {
            clearInterval(timer);
            errorMsg.textContent = '获取状态失败：' + err.message;
            startBtn.disabled = false;
            startBtn.textContent = '启动爬虫';
        }
    }, 500);
}

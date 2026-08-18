


const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const http = require('http');

// Configuration
const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TARGET_CHAT_ID = "-1003912506906";
const TARGET_URL = "https://bc.game/game/crash";

let lastProcessedGameId = null;
let totalCount = 0;

// Format current date-time (e.g., 17/08-18:03:19)
const getFormattedDateTime = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(now.getDate());
    const month = pad(now.getMonth() + 1);
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());
    return `${day}/${month}-${hours}:${minutes}:${seconds}`;
};

// Format multiplier with color indicator emoji
const formatNumberWithEmoji = (num) => {
    const val = Number(num).toFixed(2);
    if (num < 2.00) return `${val}🔴`;
    if (num < 10.00) return `${val}🟢`;
    return `${val}🟡`;
};

// Send Telegram notification
const sendTelegramMessage = async (messageText) => {
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TARGET_CHAT_ID,
                text: messageText
            })
        });
    } catch (error) {
        console.error('[TELEGRAM ERROR]', error.message);
    }
};

async function startBot() {
    console.log("[BOT START] Launching browser...");

    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    console.log(`[BOT START] Opening ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    try {
        await page.waitForSelector('.lf-row', { timeout: 30000 });
        console.log("[BOT START] Game history detected!");
    } catch (e) {
        console.log("[BOT START] Waiting for history table...");
    }

    // Polling loop
    setInterval(async () => {
        try {
            const pageData = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('.tabs-btn'));
                const historyBtn = buttons.find(btn => btn.textContent.trim().includes('History'));

                if (historyBtn && historyBtn.getAttribute('aria-selected') !== 'true') {
                    historyBtn.click();
                    return { ready: false };
                }

                const dataList = [];
                const rows = document.querySelectorAll('.lf-row');

                rows.forEach(row => {
                    const cols = row.children;
                    if (cols.length >= 2) {
                        const gameIdStr = cols[0].textContent.replace(/\D/g, '');
                        const resultStr = cols[1].textContent.trim().replace(/[^\d.]/g, '');

                        const gameId = parseInt(gameIdStr, 10);
                        const result = parseFloat(resultStr);

                        if (!isNaN(gameId) && !isNaN(result)) {
                            dataList.push({ gameId, result });
                        }
                    }
                });

                dataList.sort((a, b) => a.gameId - b.gameId);

                if (dataList.length === 0) return { ready: true, latestGameId: null, results: [] };

                const latestGameId = dataList[dataList.length - 1].gameId;
                const results = dataList.map(item => item.result);

                return { ready: true, latestGameId, results };
            });

            if (!pageData.ready || !pageData.latestGameId) return;

            const { latestGameId, results } = pageData;

            // Process only when a new game ID is detected
            if (latestGameId !== lastProcessedGameId && results.length >= 10) {
                lastProcessedGameId = latestGameId;
                totalCount++;

                // Extract last 10 crash numbers
                const last10 = results.slice(-10);
                const formattedNumbers = last10.map(num => formatNumberWithEmoji(num)).join(' ');
                const timeStr = getFormattedDateTime();

                // Display header only once every 10 messages
                const showHeader = totalCount % 10 === 1 || totalCount === 1;
                const headerText = showHeader ? "🫆 bc.game/crash\n" : "";

                const message = `🫆 join site: https://bc.game/i-3l5cmbvs3-n/\nID: #${latestGameId}🕒${timeStr}\n ${formattedNumbers}\nTotal: ${totalCount}`;

                await sendTelegramMessage(message);
                console.log(`[SENT] Game #${latestGameId}`);
            }
        } catch (err) {
            console.error("[LOOP ERROR]", err.message);
        }
    }, 1500);
}

startBot();

// HTTP server for process keep-alive
const PORT = process.env.PORT || 3001;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Last 10 Numbers Bot is running!\n');
}).listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});             

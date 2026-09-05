const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Target Telegram Channels
const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TARGET_CHAT_PUB = "-1003912506906";
const TELEGRAM_CHAT_VIPI = "-1003909320436";
const TELEGRAM_VIP2_CHAT_ID = "-1003912437402";
const TELEGRAM_CHAT_LOG = "-1004340657482";
const ENABLE_TELEGRAM = true;

// Website API Config
const WEBSITE_API_URL = "https://altincabinet.ir/api.php";
const WEBSITE_API_KEY = "AltinVIP_Secure_2026_Key";

const TARGET_URL = "https://bc.game/game/crash";
const VIP2_LOG_FILE = path.join(__dirname, 'vip_log_report.txt');

let lastProcessedGameId = null;
let consecutiveSequentialCount = 0;
let lastSentVipWarning = "";
let totalEvaluatedGamesCount = 0;
let gameHistoryRows = [];
let lastTelegramUpdateId = 0;

const createStats = () => ({
    under2: { count: 0, negPoints: 0, posPoints: 0 },
    over2: { count: 0, negPoints: 0, posPoints: 0 },
    over10: { count: 0, negPoints: 0, zeroCount: 0, posPoints: 0 },
    x3_under2: { count: 0, pts: 0 },
    x3_2to10: { count: 0, zeroCount: 0 },
    x3_10to100: { count: 0, pts: 0 },
    x3_over100: { count: 0, pts: 0 },
    totalNegPoints: 0,
    totalPosPoints: 0,
    totalPredictions: 0,
    history200: []
});

// Active models only
const MODEL_KEYS = ['X1', 'X2', 'X3'];

const modelsState = {};
MODEL_KEYS.forEach(key => {
    modelsState[key] = {
        stats: createStats(),
        totalScore: 0,
        pendingPrediction: null,
        pendingConf: null,
        lastPts: 0
    };
});

const getTimeOnly = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

const getFormattedDateTime = (includeIcon = true) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(now.getDate());
    const month = pad(now.getMonth() + 1);
    const year = now.getFullYear();
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());
    const timeStr = `${day}/${month}/${year} - ${hours}:${minutes}:${seconds}`;
    return includeIcon ? `🕒 ${timeStr}` : timeStr;
};

const safeLog = (val) => {
    if (val === 0) return 0;
    let adjustedVal = val;
    if (Math.abs(adjustedVal - 1.0) < 1e-6 || (adjustedVal > 0 && adjustedVal <= 1.0)) {
        adjustedVal = 1.01;
    }
    return Math.sign(adjustedVal) * Math.log(Math.abs(adjustedVal));
};

const safeExp = (val) => {
    if (val === 0) return 0;
    return Math.sign(val) * Math.exp(Math.abs(val));
};

// Custom score calculator
const calculatePoints = (pred, actual, key) => {
    if (pred === null || isNaN(pred) || actual === null || isNaN(actual)) return 0;

    // Custom scoring rules for X3
    if (key === 'X3' || pred === 100) {
        if (actual < 2.0) return -4;
        if (actual >= 2.0 && actual < 10.0) return 0;
        if (actual >= 10.0 && actual < 100.0) return 10;
        if (actual >= 100.0) return 110;
        return 0;
    }

    // Standard scoring for X1 and X2
    if (pred < 2) {
        return actual < 2 ? 1 : -1;
    } else if (pred >= 2 && pred < 10) {
        return actual < 2 ? -1 : 1;
    } else if (pred >= 10) {
        if (actual < 2) return -2;
        if (actual >= 2 && actual < 10) return 0;
        return 10;
    }
    return 0;
};

const calculateConfidence = (predictedVal, arr) => {
    if (!Array.isArray(arr) || arr.length < 7 || !predictedVal || isNaN(predictedVal)) {
        return 50;
    }

    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;

    const k3 = safeLog(n3);
    const adjustedN2 = (n2 <= 1.00) ? 1.01 : n2;
    const k2 = safeLog(adjustedN2);
    const k1 = safeLog(n1);

    if (Math.abs(k2) < 1e-9) return 50;

    const kConf = (k3 * k1) / k2;
    let rawNConf = safeExp(kConf);
    let nConf = rawNConf < 0 ? Math.abs(rawNConf) + 1.0 : rawNConf;

    const getRange = (v) => {
        if (v < 1.50) return 1;
        if (v < 2.00) return 2;
        if (v < 5.00) return 3;
        if (v < 10.00) return 4;
        return 5;
    };

    const rP = getRange(predictedVal);
    const rC = getRange(nConf);
    const ratio = Math.min(predictedVal, nConf) / Math.max(predictedVal, nConf);

    let pct = 50;

    if (rP === 1 && rC === 1) pct = 80 + 18 * ratio;
    else if (rP === 1 && rC === 2) pct = 60 + 35 * ratio;
    else if (rP === 1 && rC >= 3) pct = Math.min(29, 10 + 19 * ratio);
    else if (rP === 2 && rC === 1) pct = 70 + 25 * ratio;
    else if (rP === 2 && rC === 2) pct = 80 + 18 * ratio;
    else if (rP === 2 && rC >= 3) pct = Math.min(39, 15 + 24 * ratio);
    else if (rP === 3 && rC === 1) pct = Math.min(29, 10 + 19 * ratio);
    else if (rP === 3 && rC === 2) pct = Math.min(39, 15 + 24 * ratio);
    else if (rP === 3 && (rC === 3 || rC === 4)) pct = 50 + 45 * ratio;
    else if (rP === 3 && rC === 5) pct = 50 + 45 * ratio;
    else if (rP === 4 && rC === 1) pct = Math.min(19, 5 + 14 * ratio);
    else if (rP === 4 && rC === 2) pct = Math.min(29, 10 + 19 * ratio);
    else if (rP === 4 && (rC === 3 || rC === 4)) pct = 50 + 45 * ratio;
    else if (rP === 4 && rC === 5) pct = 80 + 18 * ratio;
    else if (rP === 5 && rC === 1) pct = Math.min(19, 5 + 14 * ratio);
    else if (rP === 5 && rC === 2) pct = Math.min(29, 10 + 19 * ratio);
    else if (rP === 5 && (rC === 3 || rC === 4)) pct = 50 + 45 * ratio;
    else if (rP === 5 && rC === 5) pct = 70 + 28 * ratio;

    return Math.min(98, Math.max(5, Math.round(pct)));
};

const updateStats = (stats, predVal, actualVal, pts, key) => {
    if (pts < 0) {
        stats.totalNegPoints += pts;
    } else if (pts > 0) {
        stats.totalPosPoints += pts;
    }

    if (key === 'X3' || predVal === 100) {
        if (actualVal < 2.0) {
            stats.x3_under2.count++;
            stats.x3_under2.pts += pts;
        } else if (actualVal >= 2.0 && actualVal < 10.0) {
            stats.x3_2to10.count++;
            stats.x3_2to10.zeroCount++;
        } else if (actualVal >= 10.0 && actualVal < 100.0) {
            stats.x3_10to100.count++;
            stats.x3_10to100.pts += pts;
        } else if (actualVal >= 100.0) {
            stats.x3_over100.count++;
            stats.x3_over100.pts += pts;
        }
    } else {
        if (predVal < 2.0) {
            stats.under2.count++;
            if (pts > 0) stats.under2.posPoints += pts;
            if (pts < 0) stats.under2.negPoints += pts;
        } else if (predVal >= 2.0 && predVal < 10.0) {
            stats.over2.count++;
            if (pts > 0) stats.over2.posPoints += pts;
            if (pts < 0) stats.over2.negPoints += pts;
        } else if (predVal >= 10.0) {
            stats.over10.count++;
            if (pts === 0) stats.over10.zeroCount++;
            if (pts > 0) stats.over10.posPoints += pts;
            if (pts < 0) stats.over10.negPoints += pts;
        }
    }

    stats.history200.push(pts);
    if (stats.history200.length > 200) {
        stats.history200.shift();
    }
};

// ==========================================
// FORMULA 1 (X1): Pure Logarithmic Pivot Model (Unrestricted)
// ==========================================
function predictFormula1(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return { status: 'wait' };

    const len = arr.length;
    const n1 = arr[len - 1];
    let n2 = arr[len - 2];
    const n3 = arr[len - 3];

    // Prevent division by zero
    if (n2 <= 1.00) {
        n2 = 1.01;
    }

    const ln1 = safeLog(n1);
    const ln2 = safeLog(n2);
    const ln3 = safeLog(n3);

    const k0 = (ln3 * ln1) / ln2;
    const rawN0 = safeExp(k0);
    let finalN0 = rawN0 < 0 ? Math.abs(rawN0) + 1.0 : rawN0;

    if (isNaN(finalN0) || !isFinite(finalN0)) return { status: 'wait' };
    if (finalN0 < 1.0) finalN0 = 1.01;

    return {
        status: 'predict',
        direction: finalN0 >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(finalN0.toFixed(2)),
        wasNegative: rawN0 < 0
    };
}

// ==========================================
// FORMULA 2 (X2): Dual Condition Strict Pivot
// ==========================================
function predictFormula2(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return { status: 'wait' };

    const len = arr.length;
    const n1 = arr[len - 1];
    let n2 = arr[len - 2];
    const n3 = arr[len - 3];

    if (n2 <= 1.00) {
        n2 = 1.01;
    }

    const ln1 = safeLog(n1);
    const ln2 = safeLog(n2);
    const ln3 = safeLog(n3);

    const k0 = (ln3 * ln1) / ln2;
    const rawN0 = safeExp(k0);
    let finalN0 = rawN0 < 0 ? Math.abs(rawN0) + 1.0 : rawN0;

    if (isNaN(finalN0) || !isFinite(finalN0)) return { status: 'wait' };
    if (finalN0 < 1.0) finalN0 = 1.01;

    // Part 1: Red prediction (< 2.0)
    if (n1 < 2.0 && n3 < 2.0 && finalN0 < 2.0) {
        return {
            status: 'predict',
            direction: 'dn',
            predictedValue: Number(finalN0.toFixed(2)),
            wasNegative: rawN0 < 0
        };
    }

    // Part 2: Green prediction (>= 2.0)
    if (n1 >= 2.0 && n3 >= 2.0 && finalN0 >= 2.0) {
        let finalVal = finalN0;
        if (finalVal >= 10.0) {
            finalVal = 10.0;
        }
        return {
            status: 'predict',
            direction: 'up',
            predictedValue: Number(finalVal.toFixed(2)),
            wasNegative: false
        };
    }

    return { status: 'wait' };
}

// ==========================================
// FORMULA 3 (X3): Multiplier 100 Model
// ==========================================
function predictFormula3(arr) {
    if (!Array.isArray(arr) || arr.length < 8) return { status: 'wait' };
    const len = arr.length;

    const n8 = arr[len - 8];
    const n6 = arr[len - 6];
    const n4 = arr[len - 4];
    const n2 = arr[len - 2];

    if (n8 > n4 && n6 > n2) {
        return {
            status: 'predict',
            direction: 'up',
            predictedValue: 100,
            wasNegative: false
        };
    }

    return { status: 'wait' };
}

// Website sync (temporarily disabled at dispatch)
const sendWebsiteLiveData = async (gameId, results, nextPredictions) => {
    try {
        const last8 = results.slice(-8);
        const p2 = nextPredictions['X2'];

        let predVal = "wait";
        let c2 = 50;
        let c10 = 0;

        if (p2 && p2.status === 'predict') {
            predVal = p2.predictedValue;
            let baseConf = calculateConfidence(predVal, results) || 50;
            const factor = Math.max(0.2, baseConf / 100);

            if (predVal < 2.0) {
                c2 = baseConf;
            } else if (predVal >= 2.0 && predVal < 10.0) {
                c2 = baseConf;
            } else {
                c10 = Math.min(92, Math.max(10, baseConf));
                c2 = Math.min(98, Math.max(10, Math.round(c10 + (100 - c10) * 0.70 * factor)));
            }
        }

        const payload = {
            secretKey: WEBSITE_API_KEY,
            gameId: gameId,
            history8: last8,
            prediction: predVal,
            conf2: c2,
            conf10: c10,
            status: p2 && p2.status === 'predict' ? 'ACTIVE' : 'WAITING',
            totalPredictions: totalEvaluatedGamesCount,
            last200Points: modelsState['X2'].stats.history200,
            x1: nextPredictions['X1'] && nextPredictions['X1'].status === 'predict' ? nextPredictions['X1'].predictedValue : "wait",
            x2: nextPredictions['X2'] && nextPredictions['X2'].status === 'predict' ? nextPredictions['X2'].predictedValue : "wait",
            x3: nextPredictions['X3'] && nextPredictions['X3'].status === 'predict' ? nextPredictions['X3'].predictedValue : "wait"
        };

        const response = await axios.post(WEBSITE_API_URL, payload, {
            headers: {
                'X-API-KEY': WEBSITE_API_KEY,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 7000
        });

        console.log(`[WEBSITE SYNC OK] #${gameId} -> Code: ${response.status}`);
    } catch (error) {
        if (error.response) {
            console.error(`[WEBSITE SYNC REJECTED] Server replied ${error.response.status}`);
        } else {
            console.error(`[WEBSITE SYNC ERROR] ${error.message}`);
        }
    }
};

const sendTelegramMessage = async (chatId, messageHtml) => {
    if (!chatId || !ENABLE_TELEGRAM) return;

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: messageHtml,
                parse_mode: 'HTML'
            })
        });
    } catch (error) {
        console.error(`[TELEGRAM FETCH ERROR -> ${chatId}]`, error);
    }
};

const sendTelegramDocument = async (chatId, filePath, caption = "") => {
    if (!chatId || !ENABLE_TELEGRAM || !fs.existsSync(filePath)) return;

    try {
        const fileBuffer = fs.readFileSync(filePath);
        const blob = new Blob([fileBuffer], { type: 'text/plain' });
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('document', blob, path.basename(filePath));
        if (caption) {
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
        }

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
            method: 'POST',
            body: formData
        });
    } catch (error) {
        console.error(`[TELEGRAM SEND DOC ERROR -> ${chatId}]`, error);
    }
};

const generateStructuredLogFile = () => {
    let output = `Game ID  | Predicted | Actual |  %  | Point | Model  | Time\n`;

    gameHistoryRows.forEach(row => {
        const cGame = `#${row.gameId}`.padEnd(9, ' ');
        let predStr = row.pred === "wait" ? "wait" : (typeof row.pred === 'number' && row.pred > 1000 ? "1000" : String(row.pred));
        const cPred = predStr.padEnd(10, ' ');
        const cAct = (typeof row.actual === 'number' ? row.actual.toFixed(2) : String(row.actual)).padEnd(7, ' ');
        const cConf = (row.conf !== null && row.conf !== '-' ? `${row.conf}%` : '-').padEnd(4, ' ');
        
        let ptsFormatted = "-";
        if (row.pts !== null && row.pts !== undefined) {
            ptsFormatted = row.pts >= 0 ? `+${row.pts}` : `${row.pts}`;
        }
        const cPts = ` ${ptsFormatted} `.padEnd(6, ' ');
        const cX = String(row.x).padEnd(6, ' ');
        const cTime = row.time || "-";

        output += `${cGame}| ${cPred}| ${cAct}| ${cConf}| ${cPts}| ${cX}| ${cTime}\n`;
    });

    fs.writeFileSync(VIP2_LOG_FILE, output, 'utf8');
};

const checkTelegramCommands = async () => {
    if (!ENABLE_TELEGRAM) return;

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=5`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
                lastTelegramUpdateId = update.update_id;
                const msg = update.message || update.channel_post;
                if (!msg || !msg.text) continue;

                const text = msg.text.trim().toLowerCase();
                const senderChatId = msg.chat.id;

                if (text === '/report' || text === '/file' || text === '/log') {
                    generateStructuredLogFile();
                    await sendTelegramDocument(
                        senderChatId,
                        VIP2_LOG_FILE,
                        `📁 <b>Full Log Report</b>\n<b>Games:</b> ${totalEvaluatedGamesCount}\n<b>Time:</b> ${getFormattedDateTime(false)}`
                    );
                }
            }
        }
    } catch (error) {}
};

const sendVipWarningAlert = async (warningMsg) => {
    if (!ENABLE_TELEGRAM) return;
    if (warningMsg === lastSentVipWarning) return;
    lastSentVipWarning = warningMsg;

    const warningHtml = `
<b>🚨 SYSTEM WARNING ALERT 🚨</b>
<b>─────────────────────</b>
⚠️ <b>Issue Detected:</b>
<code>${warningMsg}</code>

🔒 <b>Status:</b> Predictions PAUSED!
<b>─────────────────────</b>
`;

    await Promise.all([
        sendTelegramMessage(TELEGRAM_CHAT_VIPI, warningHtml),
        sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, warningHtml)
    ]);
};

const formatColoredNum = (num) => {
    if (num < 2.00) return `🔴${num.toFixed(2)}`;
    if (num < 10.00) return `🟢${num.toFixed(2)}`;
    return `🟡${num.toFixed(2)}`;
};

const formatNextLine = (prediction, arr) => {
    if (!prediction || prediction.status === 'wait') {
        return "wait ⚪";
    }
    const rawVal = prediction.predictedValue;
    const val = rawVal > 1000 ? 1000 : rawVal;
    const displayVal = val >= 1000 ? "1000" : val.toFixed(2);
    let note = prediction.wasNegative ? " (Negative)" : "";

    let baseConf = calculateConfidence(val, arr) || 50;
    const factor = Math.max(0.2, baseConf / 100);

    if (val < 2.0) {
        return `${displayVal} 🔴 (${baseConf}%)${note}`;
    } else if (val >= 2.0 && val < 10.0) {
        return `${displayVal} 🟢 (${baseConf}%)${note}`;
    } else {
        const c10 = Math.min(92, Math.max(10, baseConf));
        const c2 = Math.min(98, Math.max(10, Math.round(c10 + (100 - c10) * 0.70 * factor)));
        return `${displayVal} 🟢 (${c2}%)   10🟡 (${c10}%)${note}`;
    }
};

const formatVip1Line = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;

    const scoreUnder2 = stats.under2.posPoints + stats.under2.negPoints;
    const scoreOver2 = (stats.over2.posPoints + stats.over2.negPoints) + (stats.over10.posPoints + stats.over10.negPoints);

    return `🩵 ${sysName}: Total: ${stats.totalPredictions} (${scoreUnder2} / ${scoreOver2}): (${ptsSign}) ${totalSign}`;
};

const formatVip2BlockStandard = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;

    const scoreUnder2 = stats.under2.posPoints + stats.under2.negPoints;
    const scoreOver2 = (stats.over2.posPoints + stats.over2.negPoints) + (stats.over10.posPoints + stats.over10.negPoints);

    const o10Neg = stats.over10.negPoints;
    const o10Zero = stats.over10.zeroCount;
    const o10Pos = stats.over10.posPoints >= 0 ? `+${stats.over10.posPoints}` : `${stats.over10.posPoints}`;

    const last20 = stats.history200.slice(-20);
    let neg20 = 0;
    let pos20 = 0;
    last20.forEach(p => {
        if (p < 0) neg20 += p;
        if (p > 0) pos20 += p;
    });
    const pos20Str = pos20 >= 0 ? `+${pos20}` : `${pos20}`;

    let str = `🩵 ${sysName}: Total: ${stats.totalPredictions} (${scoreUnder2} / ${scoreOver2}): (${ptsSign}) ${totalSign}\n`;
    str += `Last 20 (${neg20} / ${pos20Str})\n`;
    str += `+10: ${stats.over10.count} (${o10Neg} / zero(${o10Zero}) / ${o10Pos})\n`;

    return str;
};

const formatVip2BlockX3 = (stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;

    let str = `🩵 X3: Total: ${stats.totalPredictions}: (${ptsSign}) ${totalSign}\n`;
    str += `-2: ${stats.x3_under2.count} (${stats.x3_under2.pts} / zero(0) / +0)\n`;
    str += `+2: ${stats.x3_2to10.count} (0 / zero(${stats.x3_2to10.zeroCount}) / +0)\n`;
    str += `+10: ${stats.x3_10to100.count} (${stats.x3_10to100.pts} / zero(0) / +0)\n`;
    str += `+100: ${stats.x3_over100.count} (${stats.x3_over100.pts} / 0 / zero(0) / +0)\n`;

    return str;
};

const processAndSendPrediction = async (results, gameId) => {
    const actualValue = results[results.length - 1];
    const timeStrWithIcon = getFormattedDateTime(true);
    const currentTimeOnly = getTimeOnly();

    totalEvaluatedGamesCount++;

    MODEL_KEYS.forEach(key => {
        const m = modelsState[key];
        let pts = 0;
        let predVal = "wait";
        if (m.pendingPrediction !== null && m.pendingPrediction.status === 'predict') {
            predVal = m.pendingPrediction.predictedValue;
            pts = calculatePoints(predVal, actualValue, key);
            m.totalScore += pts;
            updateStats(m.stats, predVal, actualValue, pts, key);
        }
        m.lastPts = pts;

        gameHistoryRows.push({
            gameId,
            pred: predVal,
            actual: actualValue,
            conf: m.pendingConf !== null ? m.pendingConf : '-',
            pts: pts,
            x: key,
            time: currentTimeOnly
        });
    });

    if (gameHistoryRows.length > 5000) {
        gameHistoryRows = gameHistoryRows.slice(-5000);
    }

    // Execute active models
    const p1 = predictFormula1(results);
    const p2 = predictFormula2(results);
    const p3 = predictFormula3(results);

    const nextPredictions = {
        'X1': p1,
        'X2': p2,
        'X3': p3
    };

    MODEL_KEYS.forEach(k => {
        if (nextPredictions[k] && nextPredictions[k].status === 'predict') {
            modelsState[k].stats.totalPredictions++;
        }
    });

    generateStructuredLogFile();

    const dispatchPromises = [];

    // Website sync temporarily disabled
    // dispatchPromises.push(sendWebsiteLiveData(gameId, results, nextPredictions));

    // Public Channel (last 10 multipliers)
    const last10 = results.slice(-10);
    const last10Formatted = last10.map(num => formatColoredNum(num)).join(' ');
    const pubMessage = `🫆 join site: https://bc.game/i-3l5cmbvs3-n\nID: #${gameId} ${timeStrWithIcon}\n ${last10Formatted}\nContact for VIP access & live predictions: @alias00x`;
    dispatchPromises.push(sendTelegramMessage(TARGET_CHAT_PUB, pubMessage));

    // VIP Messages (last 5 multipliers)
    const last5 = results.slice(-5);
    const last5Formatted = last5.map(num => formatColoredNum(num)).join('  ');

    // VIP I Report (X1 and X2 only)
    let vip1Message = `👑 VIP I \n`;
    vip1Message += `Game ID: #${gameId} | ${timeStrWithIcon}\n`;
    vip1Message += `${last5Formatted}\n`;
    vip1Message += `Total prediction: ${totalEvaluatedGamesCount}\n\n`;
    vip1Message += formatVip1Line("X1", modelsState['X1'].stats, modelsState['X1'].lastPts, modelsState['X1'].totalScore) + "\n";
    vip1Message += formatVip1Line("X2", modelsState['X2'].stats, modelsState['X2'].lastPts, modelsState['X2'].totalScore) + "\n\n";
    vip1Message += `Next X1:  ${formatNextLine(p1, results)}\n`;
    vip1Message += `Next X2:  ${formatNextLine(p2, results)}`;
    dispatchPromises.push(sendTelegramMessage(TELEGRAM_CHAT_VIPI, vip1Message));

    // VIP II Report (X1, X2 and X3)
    let vip2Message = `👑👑 VIP II \n`;
    vip2Message += `Game ID: #${gameId} | ${timeStrWithIcon}\n`;
    vip2Message += `${last5Formatted}\n`;
    vip2Message += `Total prediction: ${totalEvaluatedGamesCount}\n\n`;
    vip2Message += formatVip2BlockStandard("X1", modelsState['X1'].stats, modelsState['X1'].lastPts, modelsState['X1'].totalScore) + "\n";
    vip2Message += formatVip2BlockStandard("X2", modelsState['X2'].stats, modelsState['X2'].lastPts, modelsState['X2'].totalScore) + "\n";
    vip2Message += formatVip2BlockX3(modelsState['X3'].stats, modelsState['X3'].lastPts, modelsState['X3'].totalScore) + "\n";
    vip2Message += `X1:  ${formatNextLine(p1, results)}\n`;
    vip2Message += `X2:  ${formatNextLine(p2, results)}\n`;
    vip2Message += `X3:  ${formatNextLine(p3, results)}`;
    dispatchPromises.push(sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, vip2Message));

    // Log Report (Sent every 200 games)
    if (totalEvaluatedGamesCount > 0 && totalEvaluatedGamesCount % 200 === 0) {
        dispatchPromises.push(sendTelegramDocument(
            TELEGRAM_CHAT_LOG,
            VIP2_LOG_FILE,
            `📊 <b>Full Log Report</b>\n<b>Game ID:</b> #${gameId}\n<b>Total:</b> ${totalEvaluatedGamesCount}`
        ));
    }

    MODEL_KEYS.forEach(key => {
        modelsState[key].pendingPrediction = nextPredictions[key];
        modelsState[key].pendingConf = (nextPredictions[key] && nextPredictions[key].status === 'predict') 
            ? calculateConfidence(nextPredictions[key].predictedValue, results) 
            : null;
    });

    await Promise.all(dispatchPromises);
};

const isStrictlySequential = (dataList) => {
    if (dataList.length < 3) return false;
    const len = dataList.length;
    const g1 = dataList[len - 1].gameId;
    const g2 = dataList[len - 2].gameId;
    const g3 = dataList[len - 3].gameId;
    return (g1 === g2 + 1) && (g2 === g3 + 1);
};

async function startBot() {
    console.log("[BOT START] Launching Stealth Headless Browser...");
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--window-size=1920,1080'
        ]
    });

    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    console.log(`[BOT START] Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    try {
        await page.waitForSelector('.lf-row', { timeout: 30000 });
        console.log("[BOT START] Game table successfully detected!");
    } catch (e) {
        console.log("[BOT START] Waiting for game table selector...");
    }

    setInterval(checkTelegramCommands, 3500);

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

                if (dataList.length === 0) {
                    return { ready: true, latestGameId: null, results: [], dataList: [] };
                }

                const latestGameId = dataList[dataList.length - 1].gameId;
                const results = dataList.map(item => item.result);

                return { ready: true, latestGameId, results, dataList };
            });

            if (!pageData.ready) return;

            const { latestGameId, results, dataList } = pageData;

            if (latestGameId === null || dataList.length < 8) {
                await sendVipWarningAlert("BC.Game DOM Parse Error: Table rows not found or site disconnected!");
                consecutiveSequentialCount = 0;
                return;
            }

            if (latestGameId !== lastProcessedGameId) {
                const sequenceValid = isStrictlySequential(dataList);

                if (!sequenceValid) {
                    consecutiveSequentialCount = 0;
                    await sendVipWarningAlert(`Non-Sequential Game IDs Detected at #${latestGameId}!`);
                    return;
                }

                consecutiveSequentialCount++;

                if (consecutiveSequentialCount < 3) {
                    console.log(`[SEQUENCE RECOVERY] Waiting for 3 consecutive sequential games. Current: ${consecutiveSequentialCount}/3`);
                    return;
                }

                lastSentVipWarning = "";
                lastProcessedGameId = latestGameId;
                await processAndSendPrediction(results, latestGameId);
            }
        } catch (err) {
            console.error("[LOOP ERROR]", err.message);
        }
    }, 1500);
}

startBot();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running 24/7\n');
}).listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

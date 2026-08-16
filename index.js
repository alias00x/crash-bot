// send report to log every 50
// send manulaly report (telegram request)
// X1, X2, X3, X4, x5
// vip i, ii, 4, log

// added: x11,x12, x21,x22, x31,x32, x41,x42, x51,x52

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const http = require('http');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TELEGRAM_VIPI_CHAT_ID = "-1003909320436";
const TELEGRAM_VIP2_CHAT_ID = "-1003912437402";
const TELEGRAM_VIP4_CHAT_ID = "-1003926861194";
const TELEGRAM_LOG_CHAT_ID = "-1004340657482";
const ENABLE_TELEGRAM = true;

const TARGET_URL = "https://bc.game/game/crash";
const VIP2_LOG_FILE = path.join(__dirname, 'vip2_reports.txt');

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
    totalNegPoints: 0,
    totalPosPoints: 0,
    totalPredictions: 0,
    history20: []
});

// تعریف ۱۵ مدل (X1..X5 به همراه زیرشاخه های 1 و 2)
const MODEL_KEYS = [
    'X1', 'X11', 'X12',
    'X2', 'X21', 'X22',
    'X3', 'X31', 'X32',
    'X4', 'X41', 'X42',
    'X5', 'X51', 'X52'
];

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

const calculatePoints = (pred, actual) => {
    if (pred === null || isNaN(pred) || actual === null || isNaN(actual)) return 0;

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
    const k2 = safeLog(n2);
    const k1 = safeLog(n1);

    if (Math.abs(k2) < 1e-9) {
        return 50;
    }

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

const getNConfValue = (arr) => {
    if (!Array.isArray(arr) || arr.length < 7) return 1.0;
    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;
    const k3 = safeLog(n3);
    const k2 = safeLog(n2);
    const k1 = safeLog(n1);
    if (Math.abs(k2) < 1e-9) return 1.0;
    const kConf = (k3 * k1) / k2;
    let rawNConf = safeExp(kConf);
    return rawNConf < 0 ? Math.abs(rawNConf) + 1.0 : rawNConf;
};

const updateStats = (stats, predVal, actualVal, pts) => {
    if (pts < 0) {
        stats.totalNegPoints += pts;
    } else if (pts > 0) {
        stats.totalPosPoints += pts;
    }

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

    stats.history20.push(pts);
    if (stats.history20.length > 20) {
        stats.history20.shift();
    }
};

const isSimilar = (v1, v2) => {
    if (v1 === null || v2 === null || isNaN(v1) || isNaN(v2)) return false;
    const minVal = Math.min(v1, v2);
    if (minVal === 0) return Math.abs(v1 - v2) === 0;
    const pctDiff = Math.abs(v1 - v2) / minVal;
    return pctDiff <= 0.20;
};

const checkCustomException = (arr) => {
    if (!Array.isArray(arr) || arr.length < 4) {
        return { status: 'wait' };
    }

    const isR = (v) => v < 2.0;
    const isG = (v) => v >= 2.0 && v < 10.0;
    const isY = (v) => v >= 10.0;
    const isLowR = (v) => v < 1.09;

    const len = arr.length;

    if (len >= 3 && isY(arr[len - 3]) && isG(arr[len - 2]) && isG(arr[len - 1])) {
        if (isSimilar(arr[len - 2], arr[len - 1])) return { status: 'predict', predictedValue: 10.0, ruleName: 'Symmetry (YGG)' };
    }
    if (len >= 4 && isY(arr[len - 4]) && isG(arr[len - 3]) && isR(arr[len - 2]) && isG(arr[len - 1])) {
        if (isSimilar(arr[len - 3], arr[len - 1])) return { status: 'predict', predictedValue: 10.0, ruleName: 'Symmetry (YGRG)' };
    }
    if (len >= 3 && isY(arr[len - 3]) && isR(arr[len - 2]) && isR(arr[len - 1])) {
        if (isSimilar(arr[len - 2], arr[len - 1])) return { status: 'predict', predictedValue: 10.0, ruleName: 'Symmetry (YRR)' };
    }
    if (len >= 4 && isY(arr[len - 4]) && isR(arr[len - 3]) && isG(arr[len - 2]) && isR(arr[len - 1])) {
        if (isSimilar(arr[len - 3], arr[len - 1])) return { status: 'predict', predictedValue: 10.0, ruleName: 'Symmetry (YRGR)' };
    }
    if (len >= 5 && isY(arr[len - 5]) && isR(arr[len - 4]) && isG(arr[len - 3]) && isG(arr[len - 2]) && isR(arr[len - 1])) {
        if (isSimilar(arr[len - 4], arr[len - 1]) && isSimilar(arr[len - 3], arr[len - 2])) return { status: 'predict', predictedValue: 10.0, ruleName: 'Symmetry (YRGGR)' };
    }
    if (len >= 5 && isY(arr[len - 5]) && isG(arr[len - 4]) && isR(arr[len - 3]) && isR(arr[len - 2]) && isG(arr[len - 1])) {
        if (isSimilar(arr[len - 4], arr[len - 1]) && isSimilar(arr[len - 3], arr[len - 2])) return { status: 'predict', predictedValue: 10.0, ruleName: 'Symmetry (YGRRG)' };
    }

    if (len >= 4 && isLowR(arr[len - 4]) && isG(arr[len - 3]) && arr[len - 3] < 3.0 && isG(arr[len - 2]) && arr[len - 2] < 3.0 && isG(arr[len - 1])) {
        return { status: 'predict', predictedValue: 10.0, ruleName: 'Step from Zero (RGGG)' };
    }
    if (len >= 4 && isLowR(arr[len - 4]) && isR(arr[len - 3]) && isG(arr[len - 2]) && arr[len - 2] < 3.0 && isG(arr[len - 1])) {
        return { status: 'predict', predictedValue: 10.0, ruleName: 'Step from Zero (RRGG)' };
    }

    if (len >= 4 && isG(arr[len - 4]) && isG(arr[len - 3]) && isLowR(arr[len - 2]) && isG(arr[len - 1])) {
        return { status: 'predict', predictedValue: 10.0, ruleName: 'Trapped Zero (GGRG)' };
    }

    if (len >= 6) {
        const n6 = arr[len - 6];
        const n4 = arr[len - 4];
        const n2 = arr[len - 2];

        const isN6Green = isG(n6) || isY(n6);
        const isN4GreenOrMidRed = isG(n4) || (isR(n4) && n4 > 1.20);
        const isN2LowRed = isLowR(n2);

        if (isN6Green && isN4GreenOrMidRed && isN2LowRed) {
            return { status: 'predict', predictedValue: 10.0, ruleName: 'Descent Death (n6,n4,n2)' };
        }
    }

    return { status: 'wait' };
};

// فرمول های پایه X1 تا X5
const predictFormula1 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 7) return { status: 'error' };
    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;

    const k7 = safeLog(n7), k6 = safeLog(n6), k5 = safeLog(n5), k4 = safeLog(n4), k3 = safeLog(n3), k2 = safeLog(n2), k1 = safeLog(n1);

    const L5 = k7 + k5;
    const L4 = k6 + k4;
    const L3 = k5 + k3;
    const L2 = k4 + k2;
    const L1 = k3 + k1;

    const dir53 = L3 > L5 ? 'up' : 'dn';
    const dir42 = L2 > L4 ? 'up' : 'dn';
    const dir31 = L1 > L3 ? 'up' : 'dn';

    const patternKey = `${dir53}_${dir42}_${dir31}`;
    const decisionTable = {
        'up_up_up': 'up', 'up_dn_up': 'dn', 'dn_up_dn': 'up', 'dn_dn_dn': 'dn',
        'up_dn_dn': 'wait', 'up_up_dn': 'wait', 'dn_dn_up': 'wait', 'dn_up_up': 'wait'
    };

    const predictionDir = decisionTable[patternKey];
    if (predictionDir === 'wait') return { status: 'wait' };

    const avgStep = (Math.abs(L3 - L5) + Math.abs(L2 - L4) + Math.abs(L1 - L3)) / 3;
    let L0 = predictionDir === 'up' ? L2 + avgStep : L2 - avgStep;
    const k0 = L0 - k2;
    const rawN0 = safeExp(k0);

    let finalN0 = rawN0;
    let isWasNegative = false;
    if (rawN0 < 0) {
        finalN0 = Math.abs(rawN0) + 1.0;
        isWasNegative = true;
    }

    return { status: 'predict', direction: predictionDir, predictedValue: Number(finalN0.toFixed(2)), wasNegative: isWasNegative };
};

const predictFormula2 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 7) return { status: 'error' };
    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;

    const k5 = safeLog(n5), k4 = safeLog(n4), k3 = safeLog(n3), k2 = safeLog(n2), k1 = safeLog(n1);
    const L3 = k5 + k3, L2 = k4 + k2, L1 = k3 + k1;

    let pctChange = 0;
    if (Math.abs(L3) > 1e-9) pctChange = (L1 - L3) / Math.abs(L3);

    const predictionDir = pctChange >= 0 ? 'up' : 'dn';
    const L0 = L2 * (1 + pctChange);
    const k0 = L0 - k2;
    const rawN0 = safeExp(k0);

    let finalN0 = rawN0;
    let isWasNegative = false;
    if (rawN0 < 0) {
        finalN0 = Math.abs(rawN0) + 1.0;
        isWasNegative = true;
    }

    return { status: 'predict', direction: predictionDir, predictedValue: Number(finalN0.toFixed(2)), wasNegative: isWasNegative };
};

const predictFormula3 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 6) return { status: 'error' };

    const len = arr.length;
    const n1 = arr[len - 1], n2 = arr[len - 2], n3 = arr[len - 3], n4 = arr[len - 4], n6 = arr[len - 6];
    const triplet = [n6, n4, n2];
    const step1 = (n6 - 1.0) + (n4 - 1.0);
    const step2 = (n4 - 1.0) + (n2 - 1.0);

    let result = n2;
    let predictionDir = 'dn';

    if (n6 > n4 && n4 > n2) {
        predictionDir = 'dn';
        const decreaseRate = step1 !== 0 ? (step1 - step2) / step1 : 0;
        const raw = n2 * (1 - decreaseRate);
        const countUnder2 = triplet.filter(x => x < 2.0).length;
        const countBetween2And10 = triplet.filter(x => x >= 2.0 && x < 10.0).length;
        const countAbove10 = triplet.filter(x => x >= 10.0).length;

        if (countUnder2 >= 2) result = raw + 1.0;
        else if (countBetween2And10 >= 2) result = raw * 10.0;
        else if (countAbove10 === 1 && countBetween2And10 === 1 && countUnder2 === 1) result = raw * 100.0;
        else result = raw;
    } else if (n6 < n4 && n4 < n2) {
        predictionDir = 'up';
        const growthRate = step1 !== 0 ? (step2 - step1) / step1 : 0;
        const effectiveGrowth = Math.sqrt(Math.max(0, growthRate));
        const countBetween2And10 = triplet.filter(x => x >= 2.0 && x < 10.0).length;

        if (n2 >= 10.0) result = n2 + (step2 - step1) / 2;
        else if (countBetween2And10 >= 2) result = n2 * (1 + growthRate / 2);
        else result = n2 * (1 + effectiveGrowth);

        const maxAllowed = n2 * 2.5;
        if (result > maxAllowed) result = maxAllowed;
    } else if (n6 > n4 && n4 < n2) {
        predictionDir = 'up';
        const dropForce = n6 - n4;
        const scaleRatio = Math.sqrt(n2 / n6);
        const effectiveForce = dropForce * scaleRatio;
        const distToFloor = n2 - 1.0;

        if (effectiveForce > distToFloor) result = 1.0 + (effectiveForce - distToFloor);
        else result = n2 - effectiveForce;
    } else if (n6 < n4 && n4 > n2) {
        predictionDir = 'up';
        const riseForce = n4 + n6;
        const scaleRatio = Math.sqrt(n2 / n4);
        result = n2 + (riseForce * scaleRatio);
    }

    const lnN2 = Math.log(n2);
    if (lnN2 > 0) {
        const logCheck = (Math.log(n1) * Math.log(n3)) / lnN2;
        if (n2 < 2.0 && result > n2 && logCheck <= n2) result = logCheck;
        if (result > 8.0) result = logCheck;
    }

    if (result < 1.0) result = 1.0;

    return { status: 'predict', direction: predictionDir, predictedValue: Number(result.toFixed(2)), wasNegative: false };
};

const predictFormula4 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 5) return { status: 'error' };
    const last5 = arr.slice(-5);
    const weights = [0.1, 0.15, 0.2, 0.25, 0.3];
    let weightedLog = 0;
    for (let i = 0; i < 5; i++) {
        weightedLog += safeLog(last5[i]) * weights[i];
    }
    const momentum = safeLog(last5[4]) - safeLog(last5[2]);
    const targetLog = weightedLog + momentum * 0.5;
    const rawVal = safeExp(targetLog);
    const finalVal = Math.max(1.01, rawVal < 0 ? Math.abs(rawVal) + 1.0 : rawVal);
    return {
        status: 'predict',
        direction: finalVal >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(finalVal.toFixed(2)),
        wasNegative: false
    };
};

const predictFormula5 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 5) return { status: 'error' };
    const [n5, n4, n3, n2, n1] = arr.slice(-5);
    const ratio1 = n1 / Math.max(0.1, n2);
    const ratio2 = n3 / Math.max(0.1, n4);
    const avgRatio = (ratio1 + ratio2) / 2;
    let target = n1 * avgRatio;
    if (target > 50) target = 50;
    if (target < 1.0) target = 1.01;
    return {
        status: 'predict',
        direction: target >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(target.toFixed(2)),
        wasNegative: false
    };
};

// سازنده فرمول‌های فرعی 1 و 2 با فیلتر شروط n1, n2, n3 و n2, n4
const applySubRule1 = (basePrediction, arr) => {
    if (!basePrediction || basePrediction.status !== 'predict' || arr.length < 3) {
        return { status: 'wait' };
    }
    const len = arr.length;
    const n1 = arr[len - 1];
    const n2 = arr[len - 2];
    const n3 = arr[len - 3];
    const val = basePrediction.predictedValue;

    if (val >= 2.0) {
        if (n1 >= 2.0 || n2 >= 2.0 || n3 >= 2.0) return { ...basePrediction };
        return { status: 'wait' };
    } else {
        if (n1 < 2.0 || n2 < 2.0 || n3 < 2.0) return { ...basePrediction };
        return { status: 'wait' };
    }
};

const applySubRule2 = (basePrediction, arr) => {
    if (!basePrediction || basePrediction.status !== 'predict' || arr.length < 4) {
        return { status: 'wait' };
    }
    const len = arr.length;
    const n2 = arr[len - 2];
    const n4 = arr[len - 4];
    const val = basePrediction.predictedValue;

    if (val >= 2.0) {
        if (n2 >= 2.0 || n4 >= 2.0) return { ...basePrediction };
        return { status: 'wait' };
    } else {
        if (n2 < 2.0 || n4 < 2.0) return { ...basePrediction };
        return { status: 'wait' };
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
    const timeText = getFormattedDateTime(false);
    let output = `VIP II & VIP 4 Full Report | Date: ${timeText}\n\n`;
    output += `Game ID  | Predicted | Actual |  %  | Point | Model\n`;

    gameHistoryRows.forEach(row => {
        const cGame = `#${row.gameId}`.padEnd(9, ' ');
        const cPred = String(row.pred).padEnd(10, ' ');
        const cAct = (typeof row.actual === 'number' ? row.actual.toFixed(2) : String(row.actual)).padEnd(7, ' ');
        const cConf = (row.conf !== null && row.conf !== '-' ? `${row.conf}%` : '-').padEnd(4, ' ');
        
        let ptsFormatted = "-";
        if (row.pts !== null && row.pts !== undefined) {
            ptsFormatted = row.pts >= 0 ? `+${row.pts}` : `${row.pts}`;
        }
        const cPts = ` ${ptsFormatted} `.padEnd(6, ' ');
        const cX = row.x;

        output += `${cGame}| ${cPred}| ${cAct}| ${cConf}| ${cPts}| ${cX}\n`;
    });

    output += `\n================== SUMMARY STATS ==================\n`;
    MODEL_KEYS.forEach(k => {
        const s = modelsState[k].stats;
        const u2 = `${s.under2.count}(${s.under2.negPoints}/${s.under2.posPoints >= 0 ? '+' : ''}${s.under2.posPoints})`;
        const o2 = `${s.over2.count}(${s.over2.negPoints}/${s.over2.posPoints >= 0 ? '+' : ''}${s.over2.posPoints})`;
        const o10 = `${s.over10.count}(${s.over10.negPoints}/zero(${s.over10.zeroCount})/${s.over10.posPoints >= 0 ? '+' : ''}${s.over10.posPoints})`;
        output += `${k.padEnd(4)} -> -2: ${u2} | +2: ${o2} | +10: ${o10} | Total: ${s.totalPredictions}\n`;
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
                        `📁 <b>VIP Log Report</b>\n<b>Games:</b> ${totalEvaluatedGamesCount}\n<b>Time:</b> ${getFormattedDateTime(false)}`
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

🔒 <b>Status:</b> Predictions PAUSED!.
<b>─────────────────────</b>
`;

    await Promise.all([
        sendTelegramMessage(TELEGRAM_VIPI_CHAT_ID, warningHtml),
        sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, warningHtml),
        sendTelegramMessage(TELEGRAM_VIP4_CHAT_ID, warningHtml)
    ]);
};

const formatColoredNum = (num) => {
    if (num < 2.00) return `🔴 ${num}`;
    if (num < 10.00) return `🟢 ${num}`;
    return `🟡 ${num}`;
};

const formatNextLine = (prediction, arr, isWinnerInConflict = false, isLoserInConflict = false) => {
    if (!prediction || prediction.status === 'wait') {
        return "wait ⚪";
    }
    const val = prediction.predictedValue;
    const displayVal = val >= 1000 ? "+1000" : val;
    let note = prediction.wasNegative ? " (Negative)" : "";

    let baseConf = calculateConfidence(val, arr) || 50;
    if (isWinnerInConflict) baseConf = Math.max(52, Math.min(98, baseConf));
    else if (isLoserInConflict) baseConf = Math.min(48, Math.max(5, baseConf));

    const factor = Math.max(0.2, baseConf / 100);

    if (val < 2.0) {
        const c0 = Math.min(isLoserInConflict ? 48 : 98, Math.max(isWinnerInConflict ? 52 : 5, baseConf));
        return `${displayVal} 🔴 (${c0}%)${note}`;
    } else if (val >= 2.0 && val < 10.0) {
        const c2 = Math.min(isLoserInConflict ? 48 : 98, Math.max(isWinnerInConflict ? 52 : 10, baseConf));
        return `${displayVal} 🟢 (${c2}%)${note}`;
    } else {
        const c10 = Math.min(92, Math.max(10, baseConf));
        const c2 = Math.min(isLoserInConflict ? 48 : 98, Math.max(isWinnerInConflict ? 52 : 10, Math.round(c10 + (100 - c10) * 0.70 * factor)));
        return `${displayVal} 🟢 (${c2}%)   10🟡 (${c10}%)${note}`;
    }
};

const getPredictionIcon = (pred) => {
    if (!pred || pred.status === 'wait') return "⚪";
    const v = pred.predictedValue;
    if (v < 2.0) return "🔴";
    if (v < 10.0) return "🟢";
    return "🟡";
};

const formatSystemBlockVip1 = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;
    const negTot = stats.totalNegPoints;
    const posTot = stats.totalPosPoints >= 0 ? `+${stats.totalPosPoints}` : `${stats.totalPosPoints}`;
    return `🩵 <b>${sysName}: Total: </b>${stats.totalPredictions} (${negTot} / ${posTot}): (${ptsSign}) ${totalSign}`;
};

const formatSystemBlockVip2 = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;
    
    const negTot = stats.totalNegPoints;
    const posTot = stats.totalPosPoints >= 0 ? `+${stats.totalPosPoints}` : `${stats.totalPosPoints}`;

    const u2Neg = stats.under2.negPoints;
    const u2Pos = stats.under2.posPoints >= 0 ? `+${stats.under2.posPoints}` : `${stats.under2.posPoints}`;

    const o2Neg = stats.over2.negPoints;
    const o2Pos = stats.over2.posPoints >= 0 ? `+${stats.over2.posPoints}` : `${stats.over2.posPoints}`;

    const o10Neg = stats.over10.negPoints;
    const o10Zero = stats.over10.zeroCount;
    const o10Pos = stats.over10.posPoints >= 0 ? `+${stats.over10.posPoints}` : `${stats.over10.posPoints}`;

    let neg20 = 0;
    let pos20 = 0;
    stats.history20.forEach(p => {
        if (p < 0) neg20 += p;
        if (p > 0) pos20 += p;
    });
    const pos20Str = pos20 >= 0 ? `+${pos20}` : `${pos20}`;

    let str = `🩵 <b>${sysName}: Total: </b>${stats.totalPredictions} (${negTot} / ${posTot}): (${ptsSign}) ${totalSign}\n`;
    str += `<b>Last 20 </b>(${neg20} / ${pos20Str})\n`;
    str += `<b>- 2:</b> ${stats.under2.count} (${u2Neg} / ${u2Pos})\n`;
    str += `<b>+2:</b> ${stats.over2.count} (${o2Neg} / ${o2Pos})\n`;
    str += `<b>+10:</b> ${stats.over10.count} (${o10Neg} / zero(${o10Zero}) / ${o10Pos})\n`;

    return str;
};

const processAndSendPrediction = async (results, gameId) => {
    const actualValue = results[results.length - 1];
    const timeStrWithIcon = getFormattedDateTime(true);

    totalEvaluatedGamesCount++;

    // ارزیابی تمامی مدل‌ها و ثبت تاریخچه
    MODEL_KEYS.forEach(key => {
        const m = modelsState[key];
        let pts = 0;
        let predVal = "wait";
        if (m.pendingPrediction !== null && m.pendingPrediction.status === 'predict') {
            predVal = m.pendingPrediction.predictedValue;
            pts = calculatePoints(predVal, actualValue);
            m.totalScore += pts;
            updateStats(m.stats, predVal, actualValue, pts);
        }
        m.lastPts = pts;

        gameHistoryRows.push({
            gameId,
            pred: predVal,
            actual: actualValue,
            conf: m.pendingConf !== null ? m.pendingConf : '-',
            pts: pts,
            x: key
        });
    });

    if (gameHistoryRows.length > 5000) {
        gameHistoryRows = gameHistoryRows.slice(-5000);
    }

    // تولید پیش‌بینی‌های جدید
    const p1 = predictFormula1(results);
    const p2 = predictFormula2(results);
    const p3 = predictFormula3(results);
    const p4 = predictFormula4(results);
    const p5 = predictFormula5(results);

    const nextPredictions = {
        'X1': p1,
        'X11': applySubRule1(p1, results),
        'X12': applySubRule2(p1, results),

        'X2': p2,
        'X21': applySubRule1(p2, results),
        'X22': applySubRule2(p2, results),

        'X3': p3,
        'X31': applySubRule1(p3, results),
        'X32': applySubRule2(p3, results),

        'X4': p4,
        'X41': applySubRule1(p4, results),
        'X42': applySubRule2(p4, results),

        'X5': p5,
        'X51': applySubRule1(p5, results),
        'X52': applySubRule2(p5, results)
    };

    // بروزرسانی تعداد کل پیش بینی های هر مدل
    MODEL_KEYS.forEach(k => {
        if (nextPredictions[k] && nextPredictions[k].status === 'predict') {
            modelsState[k].stats.totalPredictions++;
        }
    });

    // مدیریت تعارض‌های اختصاصی برای X1 و X2 جهت گزارش در VIP I و VIP II
    const f1Active = p1 && p1.status === 'predict';
    const f2Active = p2 && p2.status === 'predict';
    let f1WinnerInConflict = false, f1LoserInConflict = false;
    let f2WinnerInConflict = false, f2LoserInConflict = false;

    if (f1Active && f2Active) {
        const f1Over2 = p1.predictedValue >= 2.0;
        const f2Over2 = p2.predictedValue >= 2.0;
        if (f1Over2 !== f2Over2) {
            const nConf = getNConfValue(results);
            const confOver2 = nConf >= 2.0;
            if (f1Over2 === confOver2 && f2Over2 !== confOver2) {
                f1WinnerInConflict = true; f2LoserInConflict = true;
            } else if (f2Over2 === confOver2 && f1Over2 !== confOver2) {
                f2WinnerInConflict = true; f1LoserInConflict = true;
            } else {
                const c1 = calculateConfidence(p1.predictedValue, results);
                const c2 = calculateConfidence(p2.predictedValue, results);
                if (c1 >= c2) { f1WinnerInConflict = true; f2LoserInConflict = true; }
                else { f2WinnerInConflict = true; f1LoserInConflict = true; }
            }
        }
    }

    const conf1 = f1Active ? calculateConfidence(p1.predictedValue, results) : null;
    const conf2 = f2Active ? calculateConfidence(p2.predictedValue, results) : null;
    const isGoodSignal = f1Active && f2Active && ((p1.predictedValue >= 2.0) === (p2.predictedValue >= 2.0)) && (conf1 || 0) > 30 && (conf2 || 0) > 30;

    const last4 = results.slice(-4);
    const last4Formatted = last4.map(num => formatColoredNum(num)).join('  ');

    generateStructuredLogFile();

    const telegramPromises = [];

    // 1. VIP I
    let vip1Status = isGoodSignal ? "Good" : "Normal";
    let vip1Message = `<b>👑 VIP I </b>\n`;
    vip1Message += `<b>Game ID:</b> #${gameId} | ${timeStrWithIcon}\n`;
    vip1Message += `${last4Formatted}\n`;
    vip1Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;
    vip1Message += formatSystemBlockVip1("X1", modelsState['X1'].stats, modelsState['X1'].lastPts, modelsState['X1'].totalScore) + "\n";
    vip1Message += formatSystemBlockVip1("X2", modelsState['X2'].stats, modelsState['X2'].lastPts, modelsState['X2'].totalScore) + "\n\n";
    vip1Message += `<b>Next X1:</b>  ${formatNextLine(p1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    vip1Message += `<b>Next X2:</b>  ${formatNextLine(p2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    vip1Message += `<b>Prediction status:</b>  ${vip1Status}`;
    telegramPromises.push(sendTelegramMessage(TELEGRAM_VIPI_CHAT_ID, vip1Message));

    // 2. VIP II
    let vip2Message = `<b>👑👑 VIP II </b>\n`;
    vip2Message += `<b>Game ID:</b> #${gameId} | ${timeStrWithIcon}\n`;
    vip2Message += `${last4Formatted}\n`;
    vip2Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;
    vip2Message += formatSystemBlockVip2("X1", modelsState['X1'].stats, modelsState['X1'].lastPts, modelsState['X1'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X2", modelsState['X2'].stats, modelsState['X2'].lastPts, modelsState['X2'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X3", modelsState['X3'].stats, modelsState['X3'].lastPts, modelsState['X3'].totalScore) + "\n";
    vip2Message += `<b>Next X1:</b>  ${formatNextLine(p1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    vip2Message += `<b>Next X2:</b>  ${formatNextLine(p2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    vip2Message += `<b>Next X3:</b>  ${formatNextLine(p3, results, false, false)}`;
    telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, vip2Message));

    // 3. VIP 4 (ساختار جدید)
    const isVip4Periodic = totalEvaluatedGamesCount > 0 && (totalEvaluatedGamesCount % 25 === 0);

    if (isVip4Periodic) {
        // گزارش کامل هر ۲۵ دست یکبار برای تمام مدل‌ها
        let vip4FullMessage = `👑👑 VIP II \n`;
        vip4FullMessage += `Game ID: #${gameId} | ${timeStrWithIcon}\n`;
        vip4FullMessage += `Total prediction: ${totalEvaluatedGamesCount}\n\n`;

        for (let i = 1; i <= 5; i++) {
            const kBase = `X${i}`;
            const k1 = `X${i}1`;
            const k2 = `X${i}2`;

            vip4FullMessage += formatSystemBlockVip2(kBase, modelsState[kBase].stats, modelsState[kBase].lastPts, modelsState[kBase].totalScore);
            vip4FullMessage += formatSystemBlockVip2(k1, modelsState[k1].stats, modelsState[k1].lastPts, modelsState[k1].totalScore);
            vip4FullMessage += formatSystemBlockVip2(k2, modelsState[k2].stats, modelsState[k2].lastPts, modelsState[k2].totalScore);
            if (i < 5) vip4FullMessage += "\n";
        }
        telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP4_CHAT_ID, vip4FullMessage));
    } else {
        // گزارش استاندارد هر دست VIP 4
        let vip4NormalMessage = `👑👑 VIP II \n`;
        vip4NormalMessage += `Game ID: #${gameId} | ${timeStrWithIcon}\n`;
        vip4NormalMessage += `${last4Formatted}\n`;
        vip4NormalMessage += `Total prediction: ${totalEvaluatedGamesCount}\n\n`;

        for (let i = 1; i <= 5; i++) {
            const kBase = `X${i}`;
            const k1 = `X${i}1`;
            const k2 = `X${i}2`;

            vip4NormalMessage += formatSystemBlockVip1(kBase, modelsState[kBase].stats, modelsState[kBase].lastPts, modelsState[kBase].totalScore) + "\n";
            vip4NormalMessage += `  ` + formatSystemBlockVip1(k1, modelsState[k1].stats, modelsState[k1].lastPts, modelsState[k1].totalScore) + "\n";
            vip4NormalMessage += `  ` + formatSystemBlockVip1(k2, modelsState[k2].stats, modelsState[k2].lastPts, modelsState[k2].totalScore) + "\n\n";
        }

        for (let i = 1; i <= 5; i++) {
            const iconBase = getPredictionIcon(nextPredictions[`X${i}`]);
            const icon1 = getPredictionIcon(nextPredictions[`X${i}1`]);
            const icon2 = getPredictionIcon(nextPredictions[`X${i}2`]);
            vip4NormalMessage += `Next X${i}, X${i}1, X${i}2:  ${iconBase} ${icon1} ${icon2}\n`;
        }

        telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP4_CHAT_ID, vip4NormalMessage));
    }

    // 4. ارسال دوره‌ای فایل لاگ به TELEGRAM_LOG_CHAT_ID
    if (totalEvaluatedGamesCount > 0 && totalEvaluatedGamesCount % 50 === 0) {
        telegramPromises.push(sendTelegramDocument(
            TELEGRAM_LOG_CHAT_ID,
            VIP2_LOG_FILE,
            `📊 <b>Full Systems Log Report</b>\n<b>Game ID:</b> #${gameId}\n<b>Total Predictions:</b> ${totalEvaluatedGamesCount}`
        ));
    }

    // بروزرسانی پیش‌بینی‌های در انتظار
    MODEL_KEYS.forEach(key => {
        modelsState[key].pendingPrediction = nextPredictions[key];
        modelsState[key].pendingConf = (nextPredictions[key] && nextPredictions[key].status === 'predict') 
            ? calculateConfidence(nextPredictions[key].predictedValue, results) 
            : null;
    });

    await Promise.all(telegramPromises);
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

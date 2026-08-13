const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const http = require('http');

const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TELEGRAM_VIPI_CHAT_ID = "-1003909320436";
const TELEGRAM_VIP2_CHAT_ID = "-1003912437402";
const TELEGRAM_VIP4_CHAT_ID = "-1003926861194";
const ENABLE_TELEGRAM = true;

const TARGET_URL = "https://bc.game/game/crash";

let lastProcessedGameId = null;
let consecutiveSequentialCount = 0;
let lastSentVipWarning = "";

let totalEvaluatedGamesCount = 0;

let totalScore1 = 0;
let pendingPrediction1 = null;

let totalScore2 = 0;
let pendingPrediction2 = null;

const createStats = () => ({
    under2: { count: 0, negPoints: 0, posPoints: 0 },
    over2: { count: 0, negPoints: 0, posPoints: 0 },
    totalNegPoints: 0,
    totalPosPoints: 0,
    totalPredictions: 0,
    history20: []
});

let stats1 = createStats();
let stats2 = createStats();

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
    if (pred < 2.0) {
        return actual < 2.0 ? 1 : -1;
    } else {
        return actual >= 2.0 ? 1 : -1;
    }
};

const calculateConfidence = (predictedVal, arr) => {
    if (!Array.isArray(arr) || arr.length < 7 || !predictedVal || isNaN(predictedVal)) {
        return 50;
    }

    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;

    const k3 = safeLog(n3);
    const k1 = safeLog(n1);
    const kConf = (k3 + k1) / 2.0;
    let nConf = safeExp(kConf);
    if (nConf < 0) nConf = Math.abs(nConf) + 1.0;

    const predOver2 = predictedVal >= 2.0;
    const confOver2 = nConf >= 2.0;

    const minV = Math.min(predictedVal, nConf);
    const maxV = Math.max(predictedVal, nConf);
    const ratio = maxV > 0 ? minV / maxV : 1.0;

    let pct = 50;

    if (predOver2 === confOver2) {
        pct = 65 + 30 * ratio;
    } else {
        pct = 45 * ratio;
    }

    return Math.min(98, Math.max(5, Math.round(pct)));
};

const getNConfValue = (arr) => {
    if (!Array.isArray(arr) || arr.length < 7) return 1.0;
    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;
    const k3 = safeLog(n3);
    const k1 = safeLog(n1);
    const kConf = (k3 + k1) / 2.0;
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
    } else {
        stats.over2.count++;
        if (pts > 0) stats.over2.posPoints += pts;
        if (pts < 0) stats.over2.negPoints += pts;
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
        if (isSimilar(arr[len - 2], arr[len - 1])) return { status: 'predict', predictedValue: 2.50, ruleName: 'Symmetry (YGG)' };
    }
    if (len >= 4 && isY(arr[len - 4]) && isG(arr[len - 3]) && isR(arr[len - 2]) && isG(arr[len - 1])) {
        if (isSimilar(arr[len - 3], arr[len - 1])) return { status: 'predict', predictedValue: 2.50, ruleName: 'Symmetry (YGRG)' };
    }
    if (len >= 3 && isY(arr[len - 3]) && isR(arr[len - 2]) && isR(arr[len - 1])) {
        if (isSimilar(arr[len - 2], arr[len - 1])) return { status: 'predict', predictedValue: 2.50, ruleName: 'Symmetry (YRR)' };
    }
    if (len >= 4 && isY(arr[len - 4]) && isR(arr[len - 3]) && isG(arr[len - 2]) && isR(arr[len - 1])) {
        if (isSimilar(arr[len - 3], arr[len - 1])) return { status: 'predict', predictedValue: 2.50, ruleName: 'Symmetry (YRGR)' };
    }
    if (len >= 5 && isY(arr[len - 5]) && isR(arr[len - 4]) && isG(arr[len - 3]) && isG(arr[len - 2]) && isR(arr[len - 1])) {
        if (isSimilar(arr[len - 4], arr[len - 1]) && isSimilar(arr[len - 3], arr[len - 2])) return { status: 'predict', predictedValue: 2.50, ruleName: 'Symmetry (YRGGR)' };
    }
    if (len >= 5 && isY(arr[len - 5]) && isG(arr[len - 4]) && isR(arr[len - 3]) && isR(arr[len - 2]) && isG(arr[len - 1])) {
        if (isSimilar(arr[len - 4], arr[len - 1]) && isSimilar(arr[len - 3], arr[len - 2])) return { status: 'predict', predictedValue: 2.50, ruleName: 'Symmetry (YGRRG)' };
    }

    if (len >= 4 && isLowR(arr[len - 4]) && isG(arr[len - 3]) && arr[len - 3] < 3.0 && isG(arr[len - 2]) && arr[len - 2] < 3.0 && isG(arr[len - 1])) {
        return { status: 'predict', predictedValue: 2.50, ruleName: 'Step from Zero (RGGG)' };
    }
    if (len >= 4 && isLowR(arr[len - 4]) && isR(arr[len - 3]) && isG(arr[len - 2]) && arr[len - 2] < 3.0 && isG(arr[len - 1])) {
        return { status: 'predict', predictedValue: 2.50, ruleName: 'Step from Zero (RRGG)' };
    }

    if (len >= 4 && isG(arr[len - 4]) && isG(arr[len - 3]) && isLowR(arr[len - 2]) && isG(arr[len - 1])) {
        return { status: 'predict', predictedValue: 2.50, ruleName: 'Trapped Zero (GGRG)' };
    }

    if (len >= 6) {
        const n6 = arr[len - 6];
        const n4 = arr[len - 4];
        const n2 = arr[len - 2];

        const isN6Green = isG(n6) || isY(n6);
        const isN4GreenOrMidRed = isG(n4) || (isR(n4) && n4 > 1.20);
        const isN2LowRed = isLowR(n2);

        if (isN6Green && isN4GreenOrMidRed && isN2LowRed) {
            return { status: 'predict', predictedValue: 2.50, ruleName: 'Descent Death (n6,n4,n2)' };
        }
    }

    return { status: 'wait' };
};

const predictFormula1 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 7) {
        return { status: 'error', message: 'Array must contain at least 7 numbers.' };
    }

    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;

    const k7 = safeLog(n7);
    const k6 = safeLog(n6);
    const k5 = safeLog(n5);
    const k4 = safeLog(n4);
    const k3 = safeLog(n3);
    const k2 = safeLog(n2);
    const k1 = safeLog(n1);

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
        'up_up_up': 'up',
        'up_dn_up': 'dn',
        'dn_up_dn': 'up',
        'dn_dn_dn': 'dn',
        'up_dn_dn': 'wait',
        'up_up_dn': 'wait',
        'dn_dn_up': 'wait',
        'dn_up_up': 'wait'
    };

    const predictionDir = decisionTable[patternKey];

    if (predictionDir === 'wait') {
        return { status: 'wait' };
    }

    const step1 = Math.abs(L3 - L5);
    const step2 = Math.abs(L2 - L4);
    const step3 = Math.abs(L1 - L3);
    const avgStep = (step1 + step2 + step3) / 3;

    let L0 = predictionDir === 'up' ? L2 + avgStep : L2 - avgStep;
    const k0 = L0 - k2;
    const rawN0 = safeExp(k0);

    let finalN0 = rawN0;
    let isWasNegative = false;

    if (rawN0 < 0) {
        finalN0 = Math.abs(rawN0) + 1.0;
        isWasNegative = true;
    }

    return {
        status: 'predict',
        direction: predictionDir,
        predictedValue: Number(finalN0.toFixed(2)),
        wasNegative: isWasNegative
    };
};

const predictFormula2 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 7) {
        return { status: 'error', message: 'Array must contain at least 7 numbers.' };
    }

    const last7 = arr.slice(-7);
    const [n7, n6, n5, n4, n3, n2, n1] = last7;

    const k5 = safeLog(n5);
    const k4 = safeLog(n4);
    const k3 = safeLog(n3);
    const k2 = safeLog(n2);
    const k1 = safeLog(n1);

    const L3 = k5 + k3;
    const L2 = k4 + k2;
    const L1 = k3 + k1;

    let pctChange = 0;
    if (Math.abs(L3) > 1e-9) {
        pctChange = (L1 - L3) / Math.abs(L3);
    }

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

    return {
        status: 'predict',
        direction: predictionDir,
        predictedValue: Number(finalN0.toFixed(2)),
        wasNegative: isWasNegative
    };
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

const formatNextLine = (prediction, arr, isWinnerInConflict, isLoserInConflict) => {
    if (!prediction || prediction.status === 'wait') {
        return "wait ⚪";
    }
    const val = prediction.predictedValue;
    let note = prediction.wasNegative ? " (Negative)" : "";

    let baseConf = calculateConfidence(val, arr) || 50;

    if (isWinnerInConflict) {
        baseConf = Math.max(52, Math.min(98, baseConf));
    } else if (isLoserInConflict) {
        baseConf = Math.min(48, Math.max(5, baseConf));
    }

    if (val < 2.0) {
        return `${val} 🔴 (${baseConf}%)${note}`;
    } else {
        return `${val} 🟢 (${baseConf}%)${note}`;
    }
};

const formatCustomLine = (customPred) => {
    if (!customPred || customPred.status === 'wait') {
        return "wait ⚪";
    }
    return `+2.50 🟢 [${customPred.ruleName}]`;
};

const formatSystemBlockVip1 = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;
    return `🩵 <b>${sysName}: Total: </b>${stats.totalPredictions}: (${ptsSign}) ${totalSign}`;
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

    return str;
};

const formatSystemBlockConsole = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;

    const negTot = stats.totalNegPoints;
    const posTot = stats.totalPosPoints >= 0 ? `+${stats.totalPosPoints}` : `${stats.totalPosPoints}`;

    const u2Neg = stats.under2.negPoints;
    const u2Pos = stats.under2.posPoints >= 0 ? `+${stats.under2.posPoints}` : `${stats.under2.posPoints}`;

    const o2Neg = stats.over2.negPoints;
    const o2Pos = stats.over2.posPoints >= 0 ? `+${stats.over2.posPoints}` : `${stats.over2.posPoints}`;

    let neg20 = 0;
    let pos20 = 0;
    stats.history20.forEach(p => {
        if (p < 0) neg20 += p;
        if (p > 0) pos20 += p;
    });
    const pos20Str = pos20 >= 0 ? `+${pos20}` : `${pos20}`;

    let str = `🩵 ${sysName}: Total: ${stats.totalPredictions} (${negTot} / ${posTot}): (${ptsSign}) ${totalSign}\n`;
    str += `Last 20 (${neg20} / ${pos20Str})\n`;
    str += `- 2: ${stats.under2.count} (${u2Neg} / ${u2Pos})\n`;
    str += `+2: ${stats.over2.count} (${o2Neg} / ${o2Pos})`;

    return str;
};

const processAndSendPrediction = async (results, gameId) => {
    const actualValue = results[results.length - 1];

    totalEvaluatedGamesCount++;

    let pts1 = 0;
    if (pendingPrediction1 !== null && pendingPrediction1.status === 'predict') {
        pts1 = calculatePoints(pendingPrediction1.predictedValue, actualValue);
        totalScore1 += pts1;
        updateStats(stats1, pendingPrediction1.predictedValue, actualValue, pts1);
    }

    let pts2 = 0;
    if (pendingPrediction2 !== null && pendingPrediction2.status === 'predict') {
        pts2 = calculatePoints(pendingPrediction2.predictedValue, actualValue);
        totalScore2 += pts2;
        updateStats(stats2, pendingPrediction2.predictedValue, actualValue, pts2);
    }

    const nextPrediction1 = predictFormula1(results);
    const nextPrediction2 = predictFormula2(results);
    const nextCustomPrediction = checkCustomException(results);

    if (nextPrediction1 && nextPrediction1.status === 'predict') {
        stats1.totalPredictions++;
    }

    if (nextPrediction2 && nextPrediction2.status === 'predict') {
        stats2.totalPredictions++;
    }

    const f1Active = nextPrediction1 && nextPrediction1.status === 'predict';
    const f2Active = nextPrediction2 && nextPrediction2.status === 'predict';

    let f1WinnerInConflict = false;
    let f1LoserInConflict = false;
    let f2WinnerInConflict = false;
    let f2LoserInConflict = false;

    if (f1Active && f2Active) {
        const f1Over2 = nextPrediction1.predictedValue >= 2.0;
        const f2Over2 = nextPrediction2.predictedValue >= 2.0;

        if (f1Over2 !== f2Over2) {
            const nConf = getNConfValue(results);
            const confOver2 = nConf >= 2.0;

            const f1Matches = f1Over2 === confOver2;
            const f2Matches = f2Over2 === confOver2;

            if (f1Matches && !f2Matches) {
                f1WinnerInConflict = true;
                f2LoserInConflict = true;
            } else if (f2Matches && !f1Matches) {
                f2WinnerInConflict = true;
                f1LoserInConflict = true;
            } else {
                const c1 = calculateConfidence(nextPrediction1.predictedValue, results);
                const c2 = calculateConfidence(nextPrediction2.predictedValue, results);
                if (c1 >= c2) {
                    f1WinnerInConflict = true;
                    f2LoserInConflict = true;
                } else {
                    f2WinnerInConflict = true;
                    f1LoserInConflict = true;
                }
            }
        }
    }

    const last4 = results.slice(-4);
    const last4Formatted = last4.map(num => formatColoredNum(num)).join('  ');

    const telegramPromises = [];

    // 1. VIP I Periodic 50-game Full Report
    if (totalEvaluatedGamesCount > 0 && totalEvaluatedGamesCount % 50 === 0) {
        let periodicReportMessage = `<b>👑 VIP II Report 👑</b>\n`;
        periodicReportMessage += `<b>Game ID:</b> #${gameId}\n`;
        periodicReportMessage += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

        periodicReportMessage += formatSystemBlockVip2("X1", stats1, pts1, totalScore1) + "\n";
        periodicReportMessage += formatSystemBlockVip2("X2", stats2, pts2, totalScore2);

        telegramPromises.push(sendTelegramMessage(TELEGRAM_VIPI_CHAT_ID, periodicReportMessage));
    }

    // 2. Standard VIP I Message
    let vip1Message = `<b>👑 VIP I 👑</b>\n`;
    vip1Message += `<b>Game ID:</b> #${gameId}\n`;
    vip1Message += `${last4Formatted}\n`;
    vip1Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

    vip1Message += formatSystemBlockVip1("X1", stats1, pts1, totalScore1) + "\n";
    vip1Message += formatSystemBlockVip1("X2", stats2, pts2, totalScore2) + "\n\n";

    vip1Message += `<b>Next X1:</b>  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    vip1Message += `<b>Next X2:</b>  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}`;

    telegramPromises.push(sendTelegramMessage(TELEGRAM_VIPI_CHAT_ID, vip1Message));

    // 3. Standard VIP II Message
    let vip2Message = `<b>👑 VIP II 👑</b>\n`;
    vip2Message += `<b>Game ID:</b> #${gameId}\n`;
    vip2Message += `${last4Formatted}\n`;
    vip2Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

    vip2Message += formatSystemBlockVip2("X1", stats1, pts1, totalScore1) + "\n";
    vip2Message += formatSystemBlockVip2("X2", stats2, pts2, totalScore2) + "\n";

    vip2Message += `<b>Next X1:</b>  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    vip2Message += `<b>Next X2:</b>  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    vip2Message += `<b>Next Custom:</b>  ${formatCustomLine(nextCustomPrediction)}`;

    telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, vip2Message));

    // 4. VIP IV Condition: Both X1 and X2 are Active & Agreed & Both Conf > 30%
    if (f1Active && f2Active) {
        const f1Over2 = nextPrediction1.predictedValue >= 2.0;
        const f2Over2 = nextPrediction2.predictedValue >= 2.0;

        const conf1 = calculateConfidence(nextPrediction1.predictedValue, results);
        const conf2 = calculateConfidence(nextPrediction2.predictedValue, results);

        if (f1Over2 === f2Over2 && conf1 > 30 && conf2 > 30) {
            let vip4Message = `<b>👑 VIP IV 👑</b>\n`;
            vip4Message += `<b>Game ID:</b> #${gameId}\n`;
            vip4Message += `${last4Formatted}\n`;
            vip4Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

            vip4Message += formatSystemBlockVip2("X1", stats1, pts1, totalScore1) + "\n";
            vip4Message += formatSystemBlockVip2("X2", stats2, pts2, totalScore2) + "\n";

            vip4Message += `<b>Next X1:</b>  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
            vip4Message += `<b>Next X2:</b>  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
            vip4Message += `<b>Next Custom:</b>  ${formatCustomLine(nextCustomPrediction)}`;

            telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP4_CHAT_ID, vip4Message));
        }
    }

    let consoleReport = `==================================================\n`;
    consoleReport += `👑 VIP II REPORT (CONSOLE) 👑\n`;
    consoleReport += `Game ID: #${gameId} | Actual Result: ${actualValue}\n`;
    consoleReport += `Last 4 Results: ${last4.join(' | ')}\n`;
    consoleReport += `Total Predictions: ${totalEvaluatedGamesCount}\n`;
    consoleReport += `--------------------------------------------------\n`;
    consoleReport += formatSystemBlockConsole("X1", stats1, pts1, totalScore1) + "\n\n";
    consoleReport += formatSystemBlockConsole("X2", stats2, pts2, totalScore2) + "\n";
    consoleReport += `--------------------------------------------------\n`;
    consoleReport += `Next X1:  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    consoleReport += `Next X2:  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    consoleReport += `Next Custom: ${formatCustomLine(nextCustomPrediction)}\n`;
    consoleReport += `==================================================`;

    console.log(consoleReport);

    pendingPrediction1 = nextPrediction1;
    pendingPrediction2 = nextPrediction2;

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

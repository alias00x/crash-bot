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

let totalScore1 = 0;
let pendingPrediction1 = null;
let pendingConf1 = null;

let totalScore2 = 0;
let pendingPrediction2 = null;
let pendingConf2 = null;

let totalScore3 = 0;
let pendingPrediction3 = null;
let pendingConf3 = null;

let totalScore4 = 0;
let pendingPrediction4 = null;
let pendingConf4 = null;

let totalScore5 = 0;
let pendingPrediction5 = null;
let pendingConf5 = null;

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

let stats1 = createStats();
let stats2 = createStats();
let stats3 = createStats();
let stats4 = createStats();
let stats5 = createStats();

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

const predictFormula3 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 6) {
        return { status: 'error', message: 'Array must contain at least 6 numbers.' };
    }

    const len = arr.length;
    const n1 = arr[len - 1];
    const n2 = arr[len - 2];
    const n3 = arr[len - 3];
    const n4 = arr[len - 4];
    const n6 = arr[len - 6];

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

        if (countUnder2 >= 2) {
            result = raw + 1.0;
        } else if (countBetween2And10 >= 2) {
            result = raw * 10.0;
        } else if (countAbove10 === 1 && countBetween2And10 === 1 && countUnder2 === 1) {
            result = raw * 100.0;
        } else if (countAbove10 >= 2) {
            result = raw;
        } else {
            result = raw;
        }
    }
    else if (n6 < n4 && n4 < n2) {
        predictionDir = 'up';
        const growthRate = step1 !== 0 ? (step2 - step1) / step1 : 0;
        const effectiveGrowth = Math.sqrt(Math.max(0, growthRate));

        const countUnder2 = triplet.filter(x => x < 2.0).length;
        const countBetween2And10 = triplet.filter(x => x >= 2.0 && x < 10.0).length;

        if (n2 >= 10.0) {
            result = n2 + (step2 - step1) / 2;
        } else if (countBetween2And10 >= 2) {
            result = n2 * (1 + growthRate / 2);
        } else if (countUnder2 >= 2) {
            result = n2 * (1 + effectiveGrowth);
        } else {
            result = n2 * (1 + effectiveGrowth);
        }

        const maxAllowed = n2 * 2.5;
        if (result > maxAllowed) {
            result = maxAllowed;
        }
    }
    else if (n6 > n4 && n4 < n2) {
        predictionDir = 'up';
        const dropForce = n6 - n4;
        const scaleRatio = Math.sqrt(n2 / n6);
        const effectiveForce = dropForce * scaleRatio;
        const distToFloor = n2 - 1.0;

        if (effectiveForce > distToFloor) {
            const reboundExcess = effectiveForce - distToFloor;
            result = 1.0 + reboundExcess;
        } else {
            result = n2 - effectiveForce;
        }
    }
    else if (n6 < n4 && n4 > n2) {
        predictionDir = 'up';
        const riseForce = n4 + n6;
        const scaleRatio = Math.sqrt(n2 / n4);
        const effectiveForce = riseForce * scaleRatio;

        result = n2 + effectiveForce;
    }

    const lnN2 = Math.log(n2);
    if (lnN2 > 0) {
        const logCheck = (Math.log(n1) * Math.log(n3)) / lnN2;

        if (n2 < 2.0 && result > n2) {
            if (logCheck <= n2) {
                result = logCheck;
            }
        }

        if (result > 8.0) {
            result = logCheck;
        }
    }

    if (result < 1.0) {
        result = 1.0;
    }

    return {
        status: 'predict',
        direction: predictionDir,
        predictedValue: Number(result.toFixed(2)),
        wasNegative: false
    };
};

const predictFormula4 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 3) {
        return { status: 'wait' };
    }

    const len = arr.length;
    const n3 = parseFloat(arr[len - 3]);
    const n2 = parseFloat(arr[len - 2]);
    const n1 = parseFloat(arr[len - 1]);

    if (isNaN(n1) || isNaN(n2) || isNaN(n3)) {
        return { status: 'wait' };
    }

    if (n1 >= 20.0) {
        return {
            status: 'predict',
            direction: 'dn',
            predictedValue: 1.50,
            wasNegative: false
        };
    }

    if (n1 < 2.00 && n2 < 2.00) {
        if (n1 <= 1.30 && n2 <= 1.30) {
            return {
                status: 'predict',
                direction: 'up',
                predictedValue: 2.00,
                wasNegative: false
            };
        }
        if (n3 < 2.00) {
            return {
                status: 'predict',
                direction: 'dn',
                predictedValue: 1.50,
                wasNegative: false
            };
        }
    }

    if (n3 < 2.00 && n2 >= 2.00 && n1 < 2.00) {
        return {
            status: 'predict',
            direction: 'up',
            predictedValue: 2.00,
            wasNegative: false
        };
    }

    if (n3 >= 2.00 && n2 < 2.00 && n1 >= 2.00) {
        return {
            status: 'predict',
            direction: 'dn',
            predictedValue: 1.50,
            wasNegative: false
        };
    }

    if (n1 >= 2.00 && n2 >= 2.00 && n3 >= 2.00) {
        const d1 = Math.log(n1);
        const d2 = Math.log(n2);
        const d3 = Math.log(n3);
        let cashout = 2.00;

        if (d2 !== 0) {
            const power = (d1 * d3) / d2;
            if (power < 10) {
                const predicted = Math.exp(power);
                cashout = predicted >= 3.0 ? Math.min(Math.floor(predicted), 5.0) : 2.00;
            }
        }
        return {
            status: 'predict',
            direction: 'up',
            predictedValue: Number(cashout.toFixed(2)),
            wasNegative: false
        };
    }

    const isMonotonic = (n2 > Math.min(n1, n3)) && (n2 < Math.max(n1, n3));
    if (isMonotonic) {
        const d1 = Math.log(n1);
        const d2 = Math.log(n2);
        const d3 = Math.log(n3);

        if (d2 !== 0) {
            const power = (d1 * d3) / d2;

            if (power < 0.693) {
                const predictedVal = Math.exp(power);
                return {
                    status: 'predict',
                    direction: 'dn',
                    predictedValue: Number(predictedVal.toFixed(2)),
                    wasNegative: false
                };
            } else if (power < 10) {
                const predicted = Math.exp(power);
                const cashout = predicted >= 10.0 ? 10.0 : Math.floor(predicted);
                return {
                    status: 'predict',
                    direction: 'up',
                    predictedValue: Number(cashout.toFixed(2)),
                    wasNegative: false
                };
            }
        }
    }

    return { status: 'wait' };
};

const predictFormula5 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 6) {
        return { status: 'x' };
    }

    const len = arr.length;
    const n6 = parseFloat(arr[len - 6]);
    const n4 = parseFloat(arr[len - 4]);
    const n3 = parseFloat(arr[len - 3]);
    const n2 = parseFloat(arr[len - 2]);
    const n1 = parseFloat(arr[len - 1]);

    if (isNaN(n1) || isNaN(n2) || isNaN(n3) || isNaN(n4) || isNaN(n6)) {
        return { status: 'x' };
    }

    const k3 = safeLog(n3);
    const k2 = safeLog(n2);
    const k1 = safeLog(n1);

    if (Math.abs(k2) < 1e-9) {
        return { status: 'x' };
    }

    const k0 = (k3 * k1) / k2;
    let rawN0 = safeExp(k0);
    let finalN0 = rawN0 < 0 ? Math.abs(rawN0) + 1.0 : rawN0;
    finalN0 = Number(finalN0.toFixed(2));

    const isOver2 = finalN0 >= 2.0;
    const n4Over2 = n4 >= 2.0;
    const n6Over2 = n6 >= 2.0;

    if (isOver2 && (n4Over2 || n6Over2)) {
        return {
            status: 'predict',
            direction: 'up',
            predictedValue: finalN0,
            wasNegative: false
        };
    } else if (!isOver2 && (!n4Over2 || !n6Over2)) {
        return {
            status: 'predict',
            direction: 'dn',
            predictedValue: finalN0,
            wasNegative: false
        };
    }

    return { status: 'x' };
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
        console.log(`[TELEGRAM LOG] Sent ${path.basename(filePath)} successfully to ${chatId}`);
    } catch (error) {
        console.error(`[TELEGRAM SEND DOC ERROR -> ${chatId}]`, error);
    }
};

const generateStructuredLogFile = () => {
    const timeText = getFormattedDateTime(false);
    let output = `VIP II Report | Date: ${timeText}\n\n`;
    output += `Game ID  | Predicted | Actual |  %  | Point | X\n`;

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

    const fmtU2 = (s) => `${s.under2.count}(${s.under2.negPoints} / ${s.under2.posPoints >= 0 ? '+' : ''}${s.under2.posPoints})`;
    const fmtO2 = (s) => `${s.over2.count}(${s.over2.negPoints} / ${s.over2.posPoints >= 0 ? '+' : ''}${s.over2.posPoints})`;
    const fmtO10 = (s) => `${s.over10.count}(${s.over10.negPoints} / zero(${s.over10.zeroCount}) / ${s.over10.posPoints >= 0 ? '+' : ''}${s.over10.posPoints})`;

    output += `\n`;
    output += `         X1     |      X2      |     X3      |     X4      |     X5\n`;
    output += `-2: ${fmtU2(stats1)},  ${fmtU2(stats2)},  ${fmtU2(stats3)},  ${fmtU2(stats4)},  ${fmtU2(stats5)}\n`;
    output += `+2: ${fmtO2(stats1)},  ${fmtO2(stats2)},  ${fmtO2(stats3)},  ${fmtO2(stats4)},  ${fmtO2(stats5)}\n`;
    output += `+10: ${fmtO10(stats1)},  ${fmtO10(stats2)},  ${fmtO10(stats3)},  ${fmtO10(stats4)},  ${fmtO10(stats5)}\n`;

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
                    console.log(`[TELEGRAM COMMAND] Executing ${text} request for chat ${senderChatId}`);
                    generateStructuredLogFile();
                    await sendTelegramDocument(
                        senderChatId,
                        VIP2_LOG_FILE,
                        `📁 <b>VIP II Log Report</b>\n<b>Games Evaluated:</b> ${totalEvaluatedGamesCount}\n<b>Time:</b> ${getFormattedDateTime(false)}`
                    );
                }
            }
        }
    } catch (error) {
        // Silently skip update poll errors
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
    if (prediction.status === 'x') {
        return "x ⚪";
    }
    const val = prediction.predictedValue;
    const displayVal = val >= 1000 ? "+1000" : val;
    let note = prediction.wasNegative ? " (Negative)" : "";

    let baseConf = calculateConfidence(val, arr) || 50;

    if (isWinnerInConflict) {
        baseConf = Math.max(52, Math.min(98, baseConf));
    } else if (isLoserInConflict) {
        baseConf = Math.min(48, Math.max(5, baseConf));
    }

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

const formatCustomLine = (customPred) => {
    if (!customPred || customPred.status === 'wait') {
        return "wait ⚪";
    }
    return `+10.00 🟡 [${customPred.ruleName}]`;
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

const formatSystemBlockConsole = (sysName, stats, lastPts, totalScore) => {
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

    let str = `${sysName}: Total: ${stats.totalPredictions} (${negTot} / ${posTot}): (${ptsSign}) ${totalSign}\n`;
    str += `Last 20 (${neg20} / ${pos20Str})\n`;
    str += `- 2: ${stats.under2.count} (${u2Neg} / ${u2Pos})\n`;
    str += `+2: ${stats.over2.count} (${o2Neg} / ${o2Pos})\n`;
    str += `+10: ${stats.over10.count} (${o10Neg} / zero(${o10Zero}) / ${o10Pos})`;

    return str;
};

const processAndSendPrediction = async (results, gameId) => {
    const actualValue = results[results.length - 1];
    const timeStrWithIcon = getFormattedDateTime(true);

    totalEvaluatedGamesCount++;

    // Evaluate X1
    let pts1 = 0;
    let predVal1 = "wait";
    if (pendingPrediction1 !== null && pendingPrediction1.status === 'predict') {
        predVal1 = pendingPrediction1.predictedValue;
        pts1 = calculatePoints(predVal1, actualValue);
        totalScore1 += pts1;
        updateStats(stats1, predVal1, actualValue, pts1);
    }
    gameHistoryRows.push({
        gameId,
        pred: predVal1,
        actual: actualValue,
        conf: pendingConf1 !== null ? pendingConf1 : '-',
        pts: pts1,
        x: 'X1'
    });

    // Evaluate X2
    let pts2 = 0;
    let predVal2 = "wait";
    if (pendingPrediction2 !== null && pendingPrediction2.status === 'predict') {
        predVal2 = pendingPrediction2.predictedValue;
        pts2 = calculatePoints(predVal2, actualValue);
        totalScore2 += pts2;
        updateStats(stats2, predVal2, actualValue, pts2);
    }
    gameHistoryRows.push({
        gameId,
        pred: predVal2,
        actual: actualValue,
        conf: pendingConf2 !== null ? pendingConf2 : '-',
        pts: pts2,
        x: 'X2'
    });

    // Evaluate X3
    let pts3 = 0;
    let predVal3 = "wait";
    if (pendingPrediction3 !== null && pendingPrediction3.status === 'predict') {
        predVal3 = pendingPrediction3.predictedValue;
        pts3 = calculatePoints(predVal3, actualValue);
        totalScore3 += pts3;
        updateStats(stats3, predVal3, actualValue, pts3);
    }
    gameHistoryRows.push({
        gameId,
        pred: predVal3,
        actual: actualValue,
        conf: pendingConf3 !== null ? pendingConf3 : '-',
        pts: pts3,
        x: 'X3'
    });

    // Evaluate X4
    let pts4 = 0;
    let predVal4 = "wait";
    if (pendingPrediction4 !== null && pendingPrediction4.status === 'predict') {
        predVal4 = pendingPrediction4.predictedValue;
        pts4 = calculatePoints(predVal4, actualValue);
        totalScore4 += pts4;
        updateStats(stats4, predVal4, actualValue, pts4);
    }
    gameHistoryRows.push({
        gameId,
        pred: predVal4,
        actual: actualValue,
        conf: pendingConf4 !== null ? pendingConf4 : '-',
        pts: pts4,
        x: 'X4'
    });

    // Evaluate X5
    let pts5 = 0;
    let predVal5 = "wait";
    if (pendingPrediction5 !== null) {
        if (pendingPrediction5.status === 'predict') {
            predVal5 = pendingPrediction5.predictedValue;
            pts5 = calculatePoints(predVal5, actualValue);
            totalScore5 += pts5;
            updateStats(stats5, predVal5, actualValue, pts5);
        } else if (pendingPrediction5.status === 'x') {
            predVal5 = "x";
        }
    }
    gameHistoryRows.push({
        gameId,
        pred: predVal5,
        actual: actualValue,
        conf: pendingConf5 !== null ? pendingConf5 : '-',
        pts: pts5,
        x: 'X5'
    });

    // Limit memory footprint: keep latest 3000 rows
    if (gameHistoryRows.length > 3000) {
        gameHistoryRows = gameHistoryRows.slice(-3000);
    }

    // Save formatted txt file to disk
    generateStructuredLogFile();

    const nextPrediction1 = predictFormula1(results);
    const nextPrediction2 = predictFormula2(results);
    const nextPrediction3 = predictFormula3(results);
    const nextPrediction4 = predictFormula4(results);
    const nextPrediction5 = predictFormula5(results);
    const nextCustomPrediction = checkCustomException(results);

    if (nextPrediction1 && nextPrediction1.status === 'predict') stats1.totalPredictions++;
    if (nextPrediction2 && nextPrediction2.status === 'predict') stats2.totalPredictions++;
    if (nextPrediction3 && nextPrediction3.status === 'predict') stats3.totalPredictions++;
    if (nextPrediction4 && nextPrediction4.status === 'predict') stats4.totalPredictions++;
    if (nextPrediction5 && nextPrediction5.status === 'predict') stats5.totalPredictions++;

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

    const conf1 = f1Active ? calculateConfidence(nextPrediction1.predictedValue, results) : null;
    const conf2 = f2Active ? calculateConfidence(nextPrediction2.predictedValue, results) : null;
    const conf3 = (nextPrediction3 && nextPrediction3.status === 'predict') ? calculateConfidence(nextPrediction3.predictedValue, results) : null;
    const conf4 = (nextPrediction4 && nextPrediction4.status === 'predict') ? calculateConfidence(nextPrediction4.predictedValue, results) : null;
    const conf5 = (nextPrediction5 && nextPrediction5.status === 'predict') ? calculateConfidence(nextPrediction5.predictedValue, results) : null;

    const f1Over2 = f1Active ? nextPrediction1.predictedValue >= 2.0 : false;
    const f2Over2 = f2Active ? nextPrediction2.predictedValue >= 2.0 : false;
    const isGoodSignal = f1Active && f2Active && (f1Over2 === f2Over2) && (conf1 || 0) > 30 && (conf2 || 0) > 30;

    const last4 = results.slice(-4);
    const last4Formatted = last4.map(num => formatColoredNum(num)).join('  ');

    const telegramPromises = [];

    // 1. Periodic 50-game Task
    if (totalEvaluatedGamesCount > 0 && totalEvaluatedGamesCount % 50 === 0) {
        let periodicReportMessage = `<b>👑👑 VIP II </b>\n`;
        periodicReportMessage += `<b>Game ID:</b> #${gameId} | ${timeStrWithIcon}\n`;
        periodicReportMessage += `${last4Formatted}\n`;
        periodicReportMessage += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

        periodicReportMessage += formatSystemBlockVip2("X1", stats1, pts1, totalScore1) + "\n";
        periodicReportMessage += formatSystemBlockVip2("X2", stats2, pts2, totalScore2) + "\n";
        periodicReportMessage += formatSystemBlockVip2("X3", stats3, pts3, totalScore3) + "\n";
        periodicReportMessage += formatSystemBlockVip2("X4", stats4, pts4, totalScore4) + "\n";
        periodicReportMessage += formatSystemBlockVip2("X5", stats5, pts5, totalScore5);

        telegramPromises.push(sendTelegramMessage(TELEGRAM_VIPI_CHAT_ID, periodicReportMessage));

        telegramPromises.push(sendTelegramDocument(
            TELEGRAM_LOG_CHAT_ID,
            VIP2_LOG_FILE,
            `📊 <b>VIP II Formatted Backup</b>\n<b>Game ID:</b> #${gameId}\n<b>Total Predictions:</b> ${totalEvaluatedGamesCount}`
        ));
    }

    // 2. Standard VIP I Message
    let vip1Status = isGoodSignal ? "Good" : "Normal";
    let vip1Message = `<b>👑 VIP I </b>\n`;
    vip1Message += `<b>Game ID:</b> #${gameId} | ${timeStrWithIcon}\n`;
    vip1Message += `${last4Formatted}\n`;
    vip1Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

    vip1Message += formatSystemBlockVip1("X1", stats1, pts1, totalScore1) + "\n";
    vip1Message += formatSystemBlockVip1("X2", stats2, pts2, totalScore2) + "\n\n";

    vip1Message += `<b>Next X1:</b>  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    vip1Message += `<b>Next X2:</b>  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    vip1Message += `<b>Prediction status:</b>  ${vip1Status}`;

    telegramPromises.push(sendTelegramMessage(TELEGRAM_VIPI_CHAT_ID, vip1Message));

    // 3. Standard VIP II Message
    let vip2Message = `<b>👑👑 VIP II </b>\n`;
    vip2Message += `<b>Game ID:</b> #${gameId} | ${timeStrWithIcon}\n`;
    vip2Message += `${last4Formatted}\n`;
    vip2Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

    vip2Message += formatSystemBlockVip2("X1", stats1, pts1, totalScore1) + "\n";
    vip2Message += formatSystemBlockVip2("X2", stats2, pts2, totalScore2) + "\n";
    vip2Message += formatSystemBlockVip2("X3", stats3, pts3, totalScore3) + "\n";
    vip2Message += formatSystemBlockVip2("X4", stats4, pts4, totalScore4) + "\n";
    vip2Message += formatSystemBlockVip2("X5", stats5, pts5, totalScore5) + "\n";

    vip2Message += `<b>Next X1:</b>  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    vip2Message += `<b>Next X2:</b>  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    vip2Message += `<b>Next X3:</b>  ${formatNextLine(nextPrediction3, results, false, false)}\n`;
    vip2Message += `<b>Next X4:</b>  ${formatNextLine(nextPrediction4, results, false, false)}\n`;
    vip2Message += `<b>Next X5:</b>  ${formatNextLine(nextPrediction5, results, false, false)}`;

    telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, vip2Message));

    // 4. VIP 4 Condition
    if (isGoodSignal) {
        let vip4Message = `<b>👑👑👑👑 VIP 4 </b>\n`;
        vip4Message += `<b>Game ID:</b> #${gameId} | ${timeStrWithIcon}\n`;
        vip4Message += `${last4Formatted}\n`;
        vip4Message += `<b>Total prediction:</b> ${totalEvaluatedGamesCount}\n\n`;

        vip4Message += formatSystemBlockVip2("X1", stats1, pts1, totalScore1) + "\n";
        vip4Message += formatSystemBlockVip2("X2", stats2, pts2, totalScore2) + "\n";

        vip4Message += `<b>Next X1:</b>  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
        vip4Message += `<b>Next X2:</b>  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}`;

        telegramPromises.push(sendTelegramMessage(TELEGRAM_VIP4_CHAT_ID, vip4Message));
    }

    let consoleReport = `==================================================\n`;
    consoleReport += `👑 VIP II REPORT (CONSOLE) 👑\n`;
    consoleReport += `Game ID: #${gameId} | ${timeStrWithIcon} | Actual Result: ${actualValue}\n`;
    consoleReport += `Last 4 Results: ${last4.join(' | ')}\n`;
    consoleReport += `Total Predictions: ${totalEvaluatedGamesCount}\n`;
    consoleReport += `--------------------------------------------------\n`;
    consoleReport += formatSystemBlockConsole("X1", stats1, pts1, totalScore1) + "\n\n";
    consoleReport += formatSystemBlockConsole("X2", stats2, pts2, totalScore2) + "\n\n";
    consoleReport += formatSystemBlockConsole("X3", stats3, pts3, totalScore3) + "\n\n";
    consoleReport += formatSystemBlockConsole("X4", stats4, pts4, totalScore4) + "\n\n";
    consoleReport += formatSystemBlockConsole("X5", stats5, pts5, totalScore5) + "\n";
    consoleReport += `--------------------------------------------------\n`;
    consoleReport += `Next X1:  ${formatNextLine(nextPrediction1, results, f1WinnerInConflict, f1LoserInConflict)}\n`;
    consoleReport += `Next X2:  ${formatNextLine(nextPrediction2, results, f2WinnerInConflict, f2LoserInConflict)}\n`;
    consoleReport += `Next X3:  ${formatNextLine(nextPrediction3, results, false, false)}\n`;
    consoleReport += `Next X4:  ${formatNextLine(nextPrediction4, results, false, false)}\n`;
    consoleReport += `Next X5:  ${formatNextLine(nextPrediction5, results, false, false)}\n`;
    consoleReport += `Next Custom: ${formatCustomLine(nextCustomPrediction)}\n`;
    consoleReport += `==================================================`;

    console.log(consoleReport);

    pendingPrediction1 = nextPrediction1;
    pendingConf1 = conf1;

    pendingPrediction2 = nextPrediction2;
    pendingConf2 = conf2;

    pendingPrediction3 = nextPrediction3;
    pendingConf3 = conf3;

    pendingPrediction4 = nextPrediction4;
    pendingConf4 = conf4;

    pendingPrediction5 = nextPrediction5;
    pendingConf5 = conf5;

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

    // Check for incoming Telegram commands every 3.5 seconds
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

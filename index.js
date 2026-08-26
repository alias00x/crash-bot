const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TARGET_CHAT_PUB = "-1003912506906";
const TELEGRAM_CHAT_VIPI = "-1003909320436";
const TELEGRAM_VIP2_CHAT_ID = "-1003912437402";
const TELEGRAM_CHAT_LOG = "-1004340657482";
const ENABLE_TELEGRAM = true;

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
    totalNegPoints: 0,
    totalPosPoints: 0,
    totalPredictions: 0,
    history20: []
});

// مدل‌های تحت پوشش سیستم
const MODEL_KEYS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X15'];

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

const isAlternating = (last6) => {
    if (last6.length < 6) return false;
    const b = last6.map(v => v >= 2.0);
    const p1 = [true, false, true, false, true, false];
    const p2 = [false, true, false, true, false, true];
    return b.every((val, idx) => val === p1[idx]) || b.every((val, idx) => val === p2[idx]);
};

const countConditionMet = (predVal, last6) => {
    if (last6.length < 6) return false;
    const countGte2 = last6.filter(v => v >= 2.0).length;
    const countLt2 = 6 - countGte2;
    if (predVal >= 2.0) {
        return countGte2 >= 2;
    } else {
        return countLt2 >= 2;
    }
};

// ==========================================
// FORMULA 1 (X1): Logarithmic Pivot Model
// ==========================================
function predictFormula1(arr) {
    if (!Array.isArray(arr) || arr.length < 6) return { status: 'wait' };
    const last6 = arr.slice(-6);

    if (isAlternating(last6)) {
        return { status: 'wait' };
    }

    const n1 = arr[arr.length - 1];
    const n2 = arr[arr.length - 2];
    const n3 = arr[arr.length - 3];

    const ln1 = safeLog(n1);
    const ln2 = safeLog(n2);
    const ln3 = safeLog(n3);

    if (Math.abs(ln2) < 1e-9) return { status: 'wait' };

    const k0 = (ln3 * ln1) / ln2;
    const rawN0 = safeExp(k0);
    let finalN0 = rawN0 < 0 ? Math.abs(rawN0) + 1.0 : rawN0;

    if (isNaN(finalN0) || !isFinite(finalN0)) return { status: 'wait' };
    if (finalN0 < 1.0) finalN0 = 1.01;

    if (!countConditionMet(finalN0, last6)) {
        return { status: 'wait' };
    }

    return {
        status: 'predict',
        direction: finalN0 >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(finalN0.toFixed(2)),
        wasNegative: rawN0 < 0
    };
}

// ==========================================
// FORMULA 2 (X2): Dynamic Rate Growth Model
// ==========================================
function predictFormula2(arr) {
    if (!Array.isArray(arr) || arr.length < 6) return { status: 'wait' };
    const last6 = arr.slice(-6);

    if (isAlternating(last6)) {
        return { status: 'wait' };
    }

    const len = arr.length;
    const n6 = arr[len - 6];
    const n4 = arr[len - 4];
    const n2 = arr[len - 2];

    if (n6 <= 0 || n4 <= 0 || n2 <= 0) return { status: 'wait' };

    let pred = n2;

    if (n6 < n4 && n4 < n2) {
        const g1 = (n4 - n6) / n6;
        const g2 = (n2 - n4) / n4;
        pred = n2 * (1 + (g1 + g2) / 2);
    } else if (n6 > n4 && n4 > n2) {
        const d1 = (n6 - n4) / n6;
        const d2 = (n4 - n2) / n4;
        pred = n2 * (1 - (d1 + d2) / 2);
    } else {
        const rate = (n4 - n6) / n6;
        pred = n2 * (1 + rate);
    }

    if (isNaN(pred) || !isFinite(pred)) return { status: 'wait' };
    if (pred < 1.0) pred = 1.01;

    if (!countConditionMet(pred, last6)) {
        return { status: 'wait' };
    }

    return {
        status: 'predict',
        direction: pred >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(pred.toFixed(2)),
        wasNegative: false
    };
}

// ==========================================
// FORMULA 3 (X3): Contrarian / Inverted Model
// ==========================================
function predictFormula3(arr) {
    if (!Array.isArray(arr) || arr.length < 6) return { status: 'wait' };
    const len = arr.length;
    const n1 = arr[len - 1];
    const n2 = arr[len - 2];
    const n3 = arr[len - 3];
    const n4 = arr[len - 4];
    const n5 = arr[len - 5];

    const ln5 = safeLog(n5);
    const ln3 = safeLog(n3);
    const ln4 = safeLog(n4);

    if (Math.abs(ln4) < 1e-9) return { status: 'wait' };

    const kPrev = (ln5 * ln3) / ln4;
    let rawPrev = safeExp(kPrev);
    let predN2 = rawPrev < 0 ? Math.abs(rawPrev) + 1.0 : rawPrev;

    let x1FailedOnN2 = false;

    if (predN2 >= 2.0) {
        if (n2 < 2.0 || n2 < 0.5 * predN2) {
            x1FailedOnN2 = true;
        }
    } else {
        if (n2 >= 2.0 || (Math.abs(n2 - predN2) / Math.max(0.1, predN2) > 0.5)) {
            x1FailedOnN2 = true;
        }
    }

    if (!x1FailedOnN2) {
        return { status: 'wait' };
    }

    const ln1 = safeLog(n1);
    const ln2 = safeLog(n2);
    if (Math.abs(ln2) < 1e-9) return { status: 'wait' };

    const k0 = (ln3 * ln1) / ln2;
    let rawN0 = safeExp(k0);
    let basePred = rawN0 < 0 ? Math.abs(rawN0) + 1.0 : rawN0;

    let invertedPred;
    if (basePred >= 2.0) {
        invertedPred = Math.max(1.10, Math.min(1.95, 2.0 / Math.max(1.05, basePred / 2)));
    } else {
        invertedPred = Math.max(2.10, 2.0 + (2.0 - basePred) * 2.5);
    }

    return {
        status: 'predict',
        direction: invertedPred >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(invertedPred.toFixed(2)),
        wasNegative: rawN0 < 0
    };
}

// ==========================================
// FORMULA 4 (X4): Ratio Multiplier Model
// ==========================================
function predictFormula4(arr) {
    if (!Array.isArray(arr) || arr.length < 5) return { status: 'wait' };
    const len = arr.length;
    const n1 = arr[len - 1];
    const n2 = arr[len - 2];
    const n3 = arr[len - 3];
    const n4 = arr[len - 4];
    const n5 = arr[len - 5];

    if (n5 <= 0 || n4 <= 0 || n3 <= 0 || n2 <= 0 || n1 <= 0) return { status: 'wait' };

    const rate53 = n3 / n5;
    const rate42 = n2 / n4;
    const rateMultiplier = rate42 / Math.max(0.001, rate53);

    const rate31 = n1 / n3;
    const targetRate = rate31 * rateMultiplier;

    let predN0 = n2 * targetRate;

    if (isNaN(predN0) || !isFinite(predN0)) return { status: 'wait' };
    if (predN0 < 1.0) predN0 = 1.01;

    return {
        status: 'predict',
        direction: predN0 >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(predN0.toFixed(2)),
        wasNegative: false
    };
}

// =========================================================================
// FORMULA 5 (X5): قانون n4 (سد واسط صعودی + فنر فشرده بازگشتی نزولی Fr)
// =========================================================================
function predictFormula5(arr) {
    if (!Array.isArray(arr) || arr.length < 8) return { status: 'wait' };
    const len = arr.length;

    // استخراج زیر‌آرایه زوج متوالی
    const n8 = arr[len - 8];
    const n6 = arr[len - 6];
    const n4 = arr[len - 4];
    const n2 = arr[len - 2];

    let predN0 = 1.5;

    // ۱. شرایط نزولی (گام رو به پایین): فنر فشرده و پتانسیل جهش
    if (n6 > n4) {
        const floorDist = Math.max(0.05, n4 - 1.00); // فشردگی به کف ۱.۰۰
        const energyIn = Math.max(0.1, n6 - 1.00);
        const Kr = energyIn / floorDist; // ضریب بازتاب فنر

        if (n4 < 1.50) {
            // فنر شدیداً فشرده شده (نزدیک ۱.۰) -> پتانسیل جهش بالا
            if (Kr >= 20.0) {
                predN0 = 1.00 + (n2 - 1.00) * (Kr / 3.0); // انفجار به سمت زرد / ۱۰+
            } else if (Kr >= 4.0) {
                predN0 = 1.00 + (n2 - 1.00) * (Kr / 4.0); // بازگشت به محدوده سبز
            } else {
                predN0 = 1.00 + (n2 - 1.00) * 1.15;
            }
        } else {
            // n4 >= 1.50 -> فنر شل است و انرژی تخلیه نمی‌شود -> ماندن در محدوده قرمز
            predN0 = Math.max(1.10, n2 * 0.85);
        }
    } 
    // ۲. شرایط صعودی (گام رو به بالا): بررسی سد یا پل ارتباطی بودن n4
    else {
        const S1 = (n8 - 1.0) + (n6 - 1.0);
        const S2 = (n6 - 1.0) + (n4 - 1.0);
        const S3 = (n4 - 1.0) + (n2 - 1.0);

        const deltaS = S3 - S2;
        let targetS4 = S3 + deltaS;

        if (n4 >= 1.50) {
            // n4 بالای ۱.۵ است -> به عنوان پل عمل کرده و صعود سبز را تثبیت می‌کند
            const dropN2 = n2 - 1.0;
            predN0 = 1.0 + Math.max(1.10, targetS4 - dropN2);
        } else {
            // n4 زیر ۱.۵ است -> سد اتلاف انرژی؛ شتاب گرفته شده و عدد قرمز می‌ماند
            const dampenedS4 = targetS4 * 0.60;
            predN0 = 1.0 + (dampenedS4 * 0.5);
            if (predN0 >= 2.0 && n2 < 2.0) {
                predN0 = 1.85; // مهار زیر مرز ۲.۰
            }
        }
    }

    if (isNaN(predN0) || !isFinite(predN0)) return { status: 'wait' };
    if (predN0 < 1.01) predN0 = 1.01;

    return {
        status: 'predict',
        direction: predN0 >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(predN0.toFixed(2)),
        wasNegative: false
    };
}

// =========================================================================
// FORMULA 6 (X6): فرمول Fn (اکستراپولیشن شیب خطی روی آرایه زوج)
// =========================================================================
function predictFormula6(arr) {
    if (!Array.isArray(arr) || arr.length < 8) return { status: 'wait' };
    const last6 = arr.slice(-6);

    if (isAlternating(last6)) {
        return { status: 'wait' };
    }

    const len = arr.length;
    const n8 = arr[len - 8];
    const n6 = arr[len - 6];
    const n4 = arr[len - 4];
    const n2 = arr[len - 2];

    // میانگین شیب خطی در ۳ گام آرایه زوج
    const deltaAvg = (n2 - n8) / 3.0;
    let predN0 = n2 + deltaAvg;

    if (isNaN(predN0) || !isFinite(predN0)) return { status: 'wait' };
    if (predN0 < 1.01) predN0 = 1.01;

    return {
        status: 'predict',
        direction: predN0 >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(predN0.toFixed(2)),
        wasNegative: false
    };
}

// =========================================================================
// FORMULA 7 (X7): فرمول Fw (شیب وزندار با شتاب گام‌های اخیر روی آرایه زوج)
// =========================================================================
function predictFormula7(arr) {
    if (!Array.isArray(arr) || arr.length < 8) return { status: 'wait' };
    const last6 = arr.slice(-6);

    if (isAlternating(last6)) {
        return { status: 'wait' };
    }

    const len = arr.length;
    const n8 = arr[len - 8];
    const n6 = arr[len - 6];
    const n4 = arr[len - 4];
    const n2 = arr[len - 2];

    const d1 = n6 - n8;
    const d2 = n4 - n6;
    const d3 = n2 - n4;

    // اعمال وزن‌های افزایشی به گام‌های نزدیک‌تر
    const weightedSlope = (0.166 * d1) + (0.333 * d2) + (0.501 * d3);
    let predN0 = n2 + weightedSlope;

    if (isNaN(predN0) || !isFinite(predN0)) return { status: 'wait' };
    if (predN0 < 1.01) predN0 = 1.01;

    return {
        status: 'predict',
        direction: predN0 >= 2.0 ? 'up' : 'dn',
        predictedValue: Number(predN0.toFixed(2)),
        wasNegative: false
    };
}

// =========================================================================
// FORMULA 15 (X15): مقایسه و همگرایی هوشمند میان X1 و X5 (قانون n4)
// =========================================================================
function predictFormula15(p1, p5) {
    if (!p1 || p1.status !== 'predict' || !p5 || p5.status !== 'predict') {
        return { status: 'wait' };
    }

    const v1 = p1.predictedValue;
    const v5 = p5.predictedValue;

    const isV1Over2 = v1 >= 2.0;
    const isV5Over2 = v5 >= 2.0;

    // عدم همگرایی جهت رنگی -> توقف و انتظار
    if (isV1Over2 !== isV5Over2) {
        return { status: 'wait' };
    }

    if (isV1Over2 && isV5Over2) {
        const isV1Over10 = v1 >= 10.0;
        const isV5Over10 = v5 >= 10.0;

        if (isV1Over10 || isV5Over10) {
            const finalVal = Math.max(v1, v5);
            return {
                status: 'predict',
                direction: 'up',
                predictedValue: Number(finalVal.toFixed(2)),
                wasNegative: false
            };
        } else {
            const avgVal = (v1 + v5) / 2;
            return {
                status: 'predict',
                direction: 'up',
                predictedValue: Number(avgVal.toFixed(2)),
                wasNegative: false
            };
        }
    } else {
        const avgVal = Math.min(1.95, Math.max(1.01, (v1 + v5) / 2));
        return {
            status: 'predict',
            direction: 'dn',
            predictedValue: Number(avgVal.toFixed(2)),
            wasNegative: p1.wasNegative || p5.wasNegative
        };
    }
}

const sendWebsiteLiveData = async (gameId, results, nextPredictions) => {
    try {
        const last8 = results.slice(-8);
        const p15 = nextPredictions['X15'];

        let predVal = "wait";
        let c2 = 50;
        let c10 = 0;

        if (p15 && p15.status === 'predict') {
            predVal = p15.predictedValue;
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
            status: p15 && p15.status === 'predict' ? 'ACTIVE' : 'WAITING',
            totalPredictions: totalEvaluatedGamesCount,
            last50Points: modelsState['X15'].stats.history20
        };

        const response = await axios.post(WEBSITE_API_URL, payload, {
            headers: {
                'X-API-KEY': WEBSITE_API_KEY,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 7000
        });

        console.log(`[WEBSITE SYNC OK] #${gameId} -> Code: ${response.status} | Pred: ${predVal}`);
    } catch (error) {
        if (error.response) {
            console.error(`[WEBSITE SYNC REJECTED] Server replied ${error.response.status}:`, error.response.data);
        } else {
            console.error(`[WEBSITE SYNC NETWORK ERROR] ${error.message}`);
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

const formatSystemBlockVip1 = (sysName, stats, lastPts, totalScore) => {
    const ptsSign = lastPts >= 0 ? `+${lastPts}` : `${lastPts}`;
    const totalSign = totalScore >= 0 ? `+${totalScore}` : `${totalScore}`;
    const negTot = stats.totalNegPoints;
    const posTot = stats.totalPosPoints >= 0 ? `+${stats.totalPosPoints}` : `${stats.totalPosPoints}`;
    return `🩵 ${sysName}: Total: ${stats.totalPredictions} (${negTot} / ${posTot}): (${ptsSign}) ${totalSign}`;
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

    let str = `🩵 ${sysName}: Total: ${stats.totalPredictions} (${negTot} / ${posTot}): (${ptsSign}) ${totalSign}\n`;
    str += `Last 20 (${neg20} / ${pos20Str})\n`;
    str += `- 2: ${stats.under2.count} (${u2Neg} / ${u2Pos})\n`;
    str += `+2: ${stats.over2.count} (${o2Neg} / ${o2Pos})\n`;
    str += `+10: ${stats.over10.count} (${o10Neg} / zero(${o10Zero}) / ${o10Pos})\n`;

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
            x: key,
            time: currentTimeOnly
        });
    });

    if (gameHistoryRows.length > 5000) {
        gameHistoryRows = gameHistoryRows.slice(-5000);
    }

    // محاسبه تمام مدل‌ها به صورت توابع مستقل
    const p1 = predictFormula1(results);
    const p2 = predictFormula2(results);
    const p3 = predictFormula3(results);
    const p4 = predictFormula4(results);
    const p5 = predictFormula5(results); // قانون n4
    const p6 = predictFormula6(results); // فرمول Fn خطی
    const p7 = predictFormula7(results); // فرمول Fw وزن‌دار
    const p15 = predictFormula15(p1, p5); // مقایسه X1 و X5

    const nextPredictions = {
        'X1': p1,
        'X2': p2,
        'X3': p3,
        'X4': p4,
        'X5': p5,
        'X6': p6,
        'X7': p7,
        'X15': p15
    };

    MODEL_KEYS.forEach(k => {
        if (nextPredictions[k] && nextPredictions[k].status === 'predict') {
            modelsState[k].stats.totalPredictions++;
        }
    });

    generateStructuredLogFile();

    const dispatchPromises = [];

    dispatchPromises.push(sendWebsiteLiveData(gameId, results, nextPredictions));

    const last10 = results.slice(-10);
    const last10Formatted = last10.map(num => formatColoredNum(num)).join(' ');
    const pubMessage = `🫆 join site: https://bc.game/i-3l5cmbvs3-n\nID: #${gameId} ${timeStrWithIcon}\n ${last10Formatted}\nContact for VIP access & live predictions: @alias00x`;
    dispatchPromises.push(sendTelegramMessage(TARGET_CHAT_PUB, pubMessage));

    const last5 = results.slice(-5);
    const last5Formatted = last5.map(num => formatColoredNum(num)).join('  ');

    // گزارش VIP I
    let vip1Message = `👑 VIP I \n`;
    vip1Message += `Game ID: #${gameId} | ${timeStrWithIcon}\n`;
    vip1Message += `${last5Formatted}\n`;
    vip1Message += `Total prediction: ${totalEvaluatedGamesCount}\n\n`;
    vip1Message += formatSystemBlockVip1("X1", modelsState['X1'].stats, modelsState['X1'].lastPts, modelsState['X1'].totalScore) + "\n";
    vip1Message += formatSystemBlockVip1("X2", modelsState['X2'].stats, modelsState['X2'].lastPts, modelsState['X2'].totalScore) + "\n\n";
    vip1Message += `Next X1:  ${formatNextLine(p1, results)}\n`;
    vip1Message += `Next X2:  ${formatNextLine(p2, results)}`;
    dispatchPromises.push(sendTelegramMessage(TELEGRAM_CHAT_VIPI, vip1Message));

    // گزارش کامل VIP II با تمامی مدل‌ها
    let vip2Message = `👑👑 VIP II \n`;
    vip2Message += `Game ID: #${gameId} | ${timeStrWithIcon}\n`;
    vip2Message += `${last5Formatted}\n`;
    vip2Message += `Total prediction: ${totalEvaluatedGamesCount}\n\n`;
    vip2Message += formatSystemBlockVip2("X1", modelsState['X1'].stats, modelsState['X1'].lastPts, modelsState['X1'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X2", modelsState['X2'].stats, modelsState['X2'].lastPts, modelsState['X2'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X3", modelsState['X3'].stats, modelsState['X3'].lastPts, modelsState['X3'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X4", modelsState['X4'].stats, modelsState['X4'].lastPts, modelsState['X4'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X5 (قانون n4)", modelsState['X5'].stats, modelsState['X5'].lastPts, modelsState['X5'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X6 (Fn خطی)", modelsState['X6'].stats, modelsState['X6'].lastPts, modelsState['X6'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X7 (Fw وزندار)", modelsState['X7'].stats, modelsState['X7'].lastPts, modelsState['X7'].totalScore) + "\n";
    vip2Message += formatSystemBlockVip2("X15 (همگرایی)", modelsState['X15'].stats, modelsState['X15'].lastPts, modelsState['X15'].totalScore) + "\n";
    vip2Message += `X1:  ${formatNextLine(p1, results)}\n`;
    vip2Message += `X2:  ${formatNextLine(p2, results)}\n`;
    vip2Message += `X3:  ${formatNextLine(p3, results)}\n`;
    vip2Message += `X4:  ${formatNextLine(p4, results)}\n`;
    vip2Message += `X5 (قانون n4): ${formatNextLine(p5, results)}\n`;
    vip2Message += `X6 (Fn خطی): ${formatNextLine(p6, results)}\n`;
    vip2Message += `X7 (Fw وزندار): ${formatNextLine(p7, results)}\n`;
    vip2Message += `X15: ${formatNextLine(p15, results)}`;
    dispatchPromises.push(sendTelegramMessage(TELEGRAM_VIP2_CHAT_ID, vip2Message));

    if (totalEvaluatedGamesCount > 0 && totalEvaluatedGamesCount % 50 === 0) {
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

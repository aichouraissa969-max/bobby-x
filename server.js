const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const geoip = require('geoip-lite');
const os = require('os');

// ========================================
//  الإعدادات الأساسية
// ========================================
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'database.json');
const LOGS_FILE = path.join(__dirname, 'data', 'user_logs.json');
const SALT_ROUNDS = 10;

// ========================================
//  Middleware
// ========================================
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.disable('x-powered-by');
app.use(express.static('public'));

// ---- Rate Limiting ----
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: '🚫 تم تجاوز الحد الأقصى للطلبات.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: '🚫 محاولات كثيرة. انتظر 15 دقيقة.' },
    skipSuccessfulRequests: true,
});

// ========================================
//  دوال جمع وحفظ المعلومات (مخفية عن المستخدم)
// ========================================

// ---- الحصول على IP الحقيقي ----
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['cf-connecting-ip'] ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip ||
           '127.0.0.1';
}

// ---- الحصول على معلومات الموقع من IP ----
function getLocationFromIP(ip) {
    try {
        const geo = geoip.lookup(ip);
        if (geo) {
            return {
                country: geo.country || 'Unknown',
                countryCode: geo.country || 'Unknown',
                city: geo.city || 'Unknown',
                region: geo.region || 'Unknown',
                timezone: geo.timezone || 'Unknown',
                lat: geo.ll?.[0] || null,
                lon: geo.ll?.[1] || null,
                zip: geo.zip || 'Unknown'
            };
        }
        return null;
    } catch (error) {
        console.error('❌ خطأ في تحديد الموقع:', error);
        return null;
    }
}

// ---- جمع معلومات المستخدم الكاملة (مخفية) ----
function collectUserInfo(req, userId = null, username = null) {
    const ip = getClientIP(req);
    const location = getLocationFromIP(ip);
    
    const userInfo = {
        userId: userId || 'anonymous',
        username: username || 'غير مسجل',
        ip: ip,
        timestamp: new Date().toISOString(),
        userAgent: req.headers['user-agent'] || 'Unknown',
        platform: req.headers['sec-ch-ua-platform'] || 'Unknown',
        location: location,
        coordinates: location ? {
            lat: location.lat,
            lon: location.lon,
            mapUrl: `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}&zoom=15`,
            googleMaps: `https://www.google.com/maps?q=${location.lat},${location.lon}`
        } : null,
        endpoint: req.originalUrl || req.url,
        method: req.method,
        hostname: os.hostname()
    };
    
    return userInfo;
}

// ---- حفظ معلومات المستخدم في ملف JSON (مخفي) ----
function saveUserLog(userInfo) {
    try {
        // إنشاء المجلد إذا لم يكن موجوداً
        const dataDir = path.dirname(LOGS_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        // قراءة الملف الحالي
        let logs = [];
        if (fs.existsSync(LOGS_FILE)) {
            try {
                const content = fs.readFileSync(LOGS_FILE, 'utf8');
                logs = JSON.parse(content);
            } catch (e) {
                logs = [];
            }
        }
        
        // إضافة السجل الجديد
        logs.push(userInfo);
        
        // الحفاظ على آخر 10000 سجل فقط
        if (logs.length > 10000) {
            logs = logs.slice(-10000);
        }
        
        // حفظ الملف
        fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
        
        // أيضاً حفظ في ملف CSV للتسهيل
        saveCSVLog(userInfo);
        
        // حفظ في ملف نصي منظم
        saveTXTLog(userInfo);
        
        return true;
    } catch (error) {
        console.error('❌ خطأ في حفظ سجل المستخدم:', error);
        return false;
    }
}

// ---- حفظ في ملف CSV ----
function saveCSVLog(userInfo) {
    try {
        const csvDir = path.join(__dirname, 'data', 'csv');
        if (!fs.existsSync(csvDir)) {
            fs.mkdirSync(csvDir, { recursive: true });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const csvFile = path.join(csvDir, `users_${today}.csv`);
        const headers = ['التاريخ','المستخدم','IP','الدولة','المدينة','خط العرض','خط الطول','نظام التشغيل','المتصفح'];
        
        // التحقق من وجود الملف
        let exists = fs.existsSync(csvFile);
        
        // كتابة البيانات
        const row = [
            new Date(userInfo.timestamp).toLocaleString('ar-EG'),
            userInfo.username || 'غير مسجل',
            userInfo.ip || 'غير معروف',
            userInfo.location?.country || 'غير معروف',
            userInfo.location?.city || 'غير معروف',
            userInfo.coordinates?.lat || 'غير معروف',
            userInfo.coordinates?.lon || 'غير معروف',
            userInfo.platform || 'غير معروف',
            userInfo.userAgent?.split(' ')[0] || 'غير معروف'
        ];
        
        const content = (exists ? '' : headers.join(',') + '\n') + row.join(',') + '\n';
        fs.appendFileSync(csvFile, content);
        
        return true;
    } catch (error) {
        console.error('❌ خطأ في حفظ CSV:', error);
        return false;
    }
}

// ---- حفظ في ملف نصي منظم (TXT) ----
function saveTXTLog(userInfo) {
    try {
        const reportsDir = path.join(__dirname, 'data', 'reports');
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const txtFile = path.join(reportsDir, `report_${today}.txt`);
        
        let content = '';
        if (fs.existsSync(txtFile)) {
            content = fs.readFileSync(txtFile, 'utf8');
        }
        
        const entry = `
${'='.repeat(70)}
📅 التاريخ: ${new Date(userInfo.timestamp).toLocaleString('ar-EG')}
👤 المستخدم: ${userInfo.username || 'غير مسجل'} (${userInfo.userId || 'مجهول'})
🌐 الـ IP: ${userInfo.ip || 'غير معروف'}
📍 الدولة: ${userInfo.location?.country || 'غير معروف'}
🏙️ المدينة: ${userInfo.location?.city || 'غير معروف'}
📏 خط العرض: ${userInfo.coordinates?.lat || 'غير معروف'}
📐 خط الطول: ${userInfo.coordinates?.lon || 'غير معروف'}
🗺️ الخريطة: ${userInfo.coordinates?.mapUrl || 'غير متوفرة'}
💻 نظام التشغيل: ${userInfo.platform || 'غير معروف'}
🌍 المتصفح: ${userInfo.userAgent?.split(' ')[0] || 'غير معروف'}
🔗 المسار: ${userInfo.endpoint || 'غير معروف'}
${'='.repeat(70)}
`;
        
        fs.appendFileSync(txtFile, entry);
        return true;
    } catch (error) {
        console.error('❌ خطأ في حفظ TXT:', error);
        return false;
    }
}

// ---- دالة تسجيل دخول المستخدم (تسجيل تلقائي) ----
function logUserActivity(req, userId = null, username = null) {
    const userInfo = collectUserInfo(req, userId, username);
    saveUserLog(userInfo);
    return userInfo;
}

// ========================================
//  قاعدة البيانات (JSON)
// ========================================
function loadDatabase() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const initialData = {
                users: {},
                chatGroups: {},
                competitions: [],
                messages: [],
                gameRooms: {},
                onlineUsers: []
            };
            const dataDir = path.dirname(DATA_FILE);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('❌ خطأ في تحميل قاعدة البيانات:', error);
        return { users: {}, chatGroups: {}, competitions: [], messages: [], gameRooms: {} };
    }
}

function saveDatabase(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ خطأ في حفظ قاعدة البيانات:', error);
        return false;
    }
}

let db = loadDatabase();

// ========================================
//  تعريف الألعاب
// ========================================
const GAMES = {
    pc: {
        cs2: { id: 'cs2', name: '💀 كونتر سترايك 2', category: 'PC', type: 'shooter', maxPlayers: 10, icon: '💀' },
        pubg: { id: 'pubg', name: '🪂 ببجي', category: 'PC/Mobile', type: 'battle_royale', maxPlayers: 100, icon: '🪂' },
        valorant: { id: 'valorant', name: '⚡ فالورانت', category: 'PC', type: 'shooter', maxPlayers: 10, icon: '⚡' },
        lol: { id: 'lol', name: '⚔️ ليج أوف ليجندز', category: 'PC', type: 'moba', maxPlayers: 10, icon: '⚔️' }
    },
    mobile: {
        freefire: { id: 'freefire', name: '🔥 فري فاير', category: 'Mobile', type: 'battle_royale', maxPlayers: 50, icon: '🔥' },
        cod_mobile: { id: 'cod_mobile', name: '💣 كول أوف ديوتي موبايل', category: 'Mobile', type: 'shooter', maxPlayers: 10, icon: '💣' },
        mlbb: { id: 'mlbb', name: '🏹 موبايل ليجندز', category: 'Mobile', type: 'moba', maxPlayers: 10, icon: '🏹' }
    },
    browser: {
        krunker: { id: 'krunker', name: '🎮 كرانكر', category: 'Browser', type: 'shooter', maxPlayers: 8, icon: '🎮' }
    }
};

function getAllGames() {
    const all = [];
    Object.values(GAMES).forEach(category => {
        Object.values(category).forEach(game => {
            all.push(game);
        });
    });
    return all;
}

function getGameById(id) {
    return getAllGames().find(g => g.id === id);
}

// ========================================
//  تهيئة مجموعات الألعاب
// ========================================
function initializeGameGroups() {
    console.log('🔄 جاري تهيئة مجموعات الألعاب...');
    const allGames = getAllGames();
    let createdCount = 0;

    allGames.forEach(game => {
        const existingGroup = Object.values(db.chatGroups).find(
            g => g.gameId === game.id && g.type === 'main'
        );

        if (!existingGroup) {
            const groupId = `group_${game.id}_main`;
            db.chatGroups[groupId] = {
                id: groupId,
                name: `🎮 ${game.name}`,
                gameId: game.id,
                gameName: game.name,
                gameIcon: game.icon,
                type: 'main',
                creator: 'system',
                members: [],
                messages: [],
                createdAt: new Date().toISOString(),
                isPrivate: false,
                maxMembers: 100
            };
            createdCount++;

            for (let i = 1; i <= 3; i++) {
                const squadId = `group_${game.id}_squad_${i}`;
                db.chatGroups[squadId] = {
                    id: squadId,
                    name: `⚔️ سكواد ${i} - ${game.name}`,
                    gameId: game.id,
                    gameName: game.name,
                    gameIcon: game.icon,
                    type: 'squad',
                    squadNumber: i,
                    creator: 'system',
                    members: [],
                    messages: [],
                    createdAt: new Date().toISOString(),
                    isPrivate: false,
                    maxMembers: 10
                };
                createdCount++;
            }
        }
    });

    if (createdCount > 0) {
        saveDatabase(db);
        console.log(`✅ تم إنشاء ${createdCount} مجموعة جديدة للألعاب`);
    }
}

// ========================================
//  دوال الأمان
// ========================================
function logLoginAttempt(username, ip, success) {
    console.log(`🔐 محاولة دخول: ${username} | IP: ${ip} | ${success ? '✅ نجاح' : '❌ فشل'}`);
}

// ========================================
//  API Routes
// ========================================

// ---- تسجيل مستخدم جديد (مع تسجيل معلوماته) ----
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password, avatar } = req.body;
        const clientIP = getClientIP(req);

        if (!username || username.length < 3) {
            return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' });
        }

        if (!password || password.length < 6) {
            return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        }

        const existingUser = Object.values(db.users).find(u => u.username === username);
        if (existingUser) {
            logLoginAttempt(username, clientIP, false);
            return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        const userId = 'user_' + Date.now();
        const user = {
            id: userId,
            username: username,
            password: hashedPassword,
            avatar: avatar || '👤',
            level: 1,
            totalPoints: 0,
            joinDate: new Date().toISOString(),
            status: 'online',
            currentGame: null,
            interestedGames: [],
            friends: [],
            gameStats: {},
            settings: {
                notifications: true,
                sound: true,
                darkMode: false
            }
        };

        getAllGames().forEach(game => {
            user.gameStats[game.id] = {
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                kills: 0,
                deaths: 0,
                rank: 'Unranked',
                points: 0,
                hoursPlayed: 0,
                lastPlayed: null
            };
        });

        db.users[userId] = user;
        logLoginAttempt(username, clientIP, true);
        saveDatabase(db);

        // ✅ تسجيل معلومات المستخدم (IP والموقع) - مخفي
        logUserActivity(req, userId, username);

        const { password: _, ...userWithoutPassword } = user;

        res.status(201).json({
            success: true,
            user: userWithoutPassword
        });
    } catch (error) {
        console.error('❌ خطأ في التسجيل:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ---- تسجيل الدخول (مع تسجيل معلوماته) ----
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        const clientIP = getClientIP(req);

        if (!username || !password) {
            return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
        }

        const user = Object.values(db.users).find(u => u.username === username);
        if (!user) {
            logLoginAttempt(username, clientIP, false);
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            logLoginAttempt(username, clientIP, false);
            return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
        }

        user.status = 'online';
        user.lastLogin = new Date().toISOString();
        user.loginCount = (user.loginCount || 0) + 1;
        saveDatabase(db);

        logLoginAttempt(username, clientIP, true);

        // ✅ تسجيل معلومات المستخدم (IP والموقع) - مخفي
        logUserActivity(req, user.id, username);

        const { password: _, ...userWithoutPassword } = user;

        res.json({
            success: true,
            user: userWithoutPassword
        });
    } catch (error) {
        console.error('❌ خطأ في تسجيل الدخول:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ---- تغيير كلمة المرور ----
app.post('/api/change-password', async (req, res) => {
    try {
        const { userId, currentPassword, newPassword } = req.body;

        if (!userId || !currentPassword || !newPassword) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
        }

        const user = db.users[userId];
        if (!user) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }

        const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
        user.password = hashedPassword;
        user.lastPasswordChange = new Date().toISOString();
        saveDatabase(db);

        // ✅ تسجيل تغيير كلمة المرور
        logUserActivity(req, userId, user.username);

        res.json({ success: true, message: 'تم تحديث كلمة المرور بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في تحديث كلمة المرور:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ---- الحصول على معلومات المستخدم ----
app.get('/api/users/:id', (req, res) => {
    const user = db.users[req.params.id];
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const { password, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
});

app.get('/api/users', (req, res) => {
    const users = Object.values(db.users).map(user => {
        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
    });
    res.json(users);
});

// ---- المجموعات ----
app.post('/api/groups', (req, res) => {
    const { name, gameId, creatorId } = req.body;

    if (!name || !gameId) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    const game = getGameById(gameId);
    if (!game) {
        return res.status(400).json({ error: 'لعبة غير موجودة' });
    }

    const groupId = 'group_' + Date.now();
    const group = {
        id: groupId,
        name: name,
        gameId: gameId,
        gameName: game.name,
        gameIcon: game.icon,
        creator: creatorId || 'system',
        members: [creatorId].filter(id => id),
        messages: [],
        createdAt: new Date().toISOString(),
        isPrivate: false,
        maxMembers: 50
    };

    db.chatGroups[groupId] = group;
    saveDatabase(db);

    res.status(201).json({ success: true, group: group });
});

app.get('/api/groups', (req, res) => {
    const groups = Object.values(db.chatGroups);
    res.json(groups);
});

app.get('/api/groups/:id', (req, res) => {
    const group = db.chatGroups[req.params.id];
    if (!group) {
        return res.status(404).json({ error: 'المجموعة غير موجودة' });
    }
    res.json(group);
});

app.post('/api/groups/:id/join', (req, res) => {
    const { userId } = req.body;
    const group = db.chatGroups[req.params.id];

    if (!group) {
        return res.status(404).json({ error: 'المجموعة غير موجودة' });
    }

    if (group.members.includes(userId)) {
        return res.status(400).json({ error: 'أنت عضو بالفعل' });
    }

    group.members.push(userId);
    saveDatabase(db);

    res.json({ success: true, group: group });
});

app.post('/api/groups/:id/leave', (req, res) => {
    const { userId } = req.body;
    const group = db.chatGroups[req.params.id];

    if (!group) {
        return res.status(404).json({ error: 'المجموعة غير موجودة' });
    }

    group.members = group.members.filter(id => id !== userId);
    saveDatabase(db);

    res.json({ success: true, group: group });
});

// ---- المسابقات ----
app.post('/api/competitions', (req, res) => {
    const { gameId, name, prize, maxPlayers, startDate, createdBy } = req.body;

    const game = getGameById(gameId);
    if (!game) {
        return res.status(400).json({ error: 'لعبة غير موجودة' });
    }

    const competition = {
        id: 'comp_' + Date.now(),
        gameId: gameId,
        gameName: game.name,
        gameIcon: game.icon,
        name: name,
        prize: prize || '🏅 جائزة',
        maxPlayers: maxPlayers || game.maxPlayers || 10,
        participants: [],
        startDate: startDate || new Date().toISOString(),
        endDate: null,
        status: 'upcoming',
        winner: null,
        createdBy: createdBy || 'system',
        createdAt: new Date().toISOString()
    };

    db.competitions.push(competition);
    saveDatabase(db);

    res.status(201).json({ success: true, competition: competition });
});

app.get('/api/competitions', (req, res) => {
    res.json(db.competitions);
});

app.post('/api/competitions/:id/join', (req, res) => {
    const { userId } = req.body;
    const competition = db.competitions.find(c => c.id === req.params.id);

    if (!competition) {
        return res.status(404).json({ error: 'المسابقة غير موجودة' });
    }

    if (competition.participants.includes(userId)) {
        return res.status(400).json({ error: 'أنت مشترك بالفعل' });
    }

    competition.participants.push(userId);
    saveDatabase(db);

    res.json({ success: true, competition: competition });
});

// ---- البحث عن مباراة ----
app.post('/api/matchmaking', (req, res) => {
    const { gameId, userId } = req.body;

    const game = getGameById(gameId);
    if (!game) {
        return res.status(400).json({ error: 'لعبة غير موجودة' });
    }

    const rooms = Object.values(db.gameRooms || {});
    const availableRoom = rooms.find(r =>
        r.gameId === gameId &&
        r.players.length < game.maxPlayers &&
        r.status === 'waiting'
    );

    if (availableRoom) {
        availableRoom.players.push(userId);
        if (availableRoom.players.length >= game.maxPlayers) {
            availableRoom.status = 'starting';
        }
        saveDatabase(db);
        return res.json({ success: true, room: availableRoom, isNew: false });
    }

    const roomId = 'room_' + Date.now();
    const newRoom = {
        id: roomId,
        gameId: gameId,
        gameName: game.name,
        gameIcon: game.icon,
        players: [userId],
        maxPlayers: game.maxPlayers,
        status: 'waiting',
        createdAt: new Date().toISOString()
    };

    if (!db.gameRooms) db.gameRooms = {};
    db.gameRooms[roomId] = newRoom;
    saveDatabase(db);

    res.json({ success: true, room: newRoom, isNew: true });
});

// ---- الأصدقاء ----
app.post('/api/friends/add', (req, res) => {
    const { userId, friendId } = req.body;

    if (!db.users[userId] || !db.users[friendId]) {
        return res.status(404).json({ error: 'مستخدم غير موجود' });
    }

    if (userId === friendId) {
        return res.status(400).json({ error: 'لا يمكن إضافة نفسك' });
    }

    if (db.users[userId].friends.includes(friendId)) {
        return res.status(400).json({ error: 'هذا المستخدم موجود بالفعل في قائمة أصدقائك' });
    }

    db.users[userId].friends.push(friendId);
    saveDatabase(db);

    res.json({ success: true, friends: db.users[userId].friends });
});

app.get('/api/friends/:userId', (req, res) => {
    const user = db.users[req.params.userId];
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const friends = user.friends.map(id => {
        const friend = db.users[id];
        if (friend) {
            const { password, ...friendWithoutPassword } = friend;
            return friendWithoutPassword;
        }
        return null;
    }).filter(f => f);

    res.json(friends);
});

// ---- البحث عن مستخدمين ----
app.get('/api/search/users', (req, res) => {
    const query = req.query.q || '';
    const users = Object.values(db.users);

    const results = users
        .filter(u => u.username.toLowerCase().includes(query.toLowerCase()))
        .map(u => {
            const { password, ...userWithoutPassword } = u;
            return userWithoutPassword;
        });

    res.json(results);
});

// ---- إحصائيات ----
app.get('/api/stats/:userId', (req, res) => {
    const user = db.users[req.params.userId];
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    res.json(user.gameStats);
});

app.get('/api/leaderboard/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    const users = Object.values(db.users);

    const sorted = users
        .filter(u => u.gameStats[gameId])
        .map(u => ({
            username: u.username,
            avatar: u.avatar,
            stats: u.gameStats[gameId],
            totalPoints: u.totalPoints
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints)
        .slice(0, 10);

    res.json(sorted);
});

// ========================================
//  WebSocket (Socket.io)
// ========================================
io.on('connection', (socket) => {
    console.log('🟢 مستخدم جديد اتصل:', socket.id);

    socket.on('register', (userId) => {
        socket.userId = userId;
        if (db.users[userId]) {
            db.users[userId].status = 'online';
            saveDatabase(db);
            io.emit('users_online', getOnlineUsers());
            io.emit('user_joined', {
                userId: userId,
                username: db.users[userId].username,
                avatar: db.users[userId].avatar
            });
        }
    });

    socket.on('join_group', (groupId) => {
        socket.join(groupId);
        const group = db.chatGroups[groupId];
        if (group) {
            socket.emit('group_messages', group.messages);
            io.to(groupId).emit('group_member_joined', {
                userId: socket.userId,
                username: db.users[socket.userId]?.username
            });
        }
    });

    socket.on('group_message', (data) => {
        const { groupId, message } = data;
        const group = db.chatGroups[groupId];
        if (group) {
            const msg = {
                id: 'msg_' + Date.now(),
                from: socket.userId,
                username: db.users[socket.userId]?.username || 'مجهول',
                avatar: db.users[socket.userId]?.avatar || '👤',
                text: message,
                time: new Date().toISOString(),
                gameId: group.gameId
            };
            group.messages.push(msg);
            saveDatabase(db);
            io.to(groupId).emit('group_message', msg);
        }
    });

    let randomChatPartner = null;

    socket.on('find_random_chat', (gameFilter = 'all') => {
        const onlineUsers = getOnlineUsers();
        let candidates = onlineUsers.filter(id => id !== socket.userId);

        if (gameFilter !== 'all') {
            const game = getGameById(gameFilter);
            if (game) {
                candidates = candidates.filter(id => {
                    const user = db.users[id];
                    return user && (user.currentGame === gameFilter || user.interestedGames?.includes(gameFilter));
                });
            }
        }

        if (candidates.length === 0) {
            socket.emit('random_chat_status', {
                status: 'waiting',
                message: '🔍 لا يوجد متاحين حالياً...'
            });
            return;
        }

        const partnerId = candidates[Math.floor(Math.random() * candidates.length)];
        randomChatPartner = partnerId;

        const partnerSocket = getSocketByUserId(partnerId);
        if (partnerSocket) {
            partnerSocket.emit('random_chat_status', {
                status: 'connected',
                partner: {
                    id: socket.userId,
                    username: db.users[socket.userId]?.username,
                    avatar: db.users[socket.userId]?.avatar,
                    gameFilter: gameFilter
                }
            });
        }

        socket.emit('random_chat_status', {
            status: 'connected',
            partner: {
                id: partnerId,
                username: db.users[partnerId]?.username,
                avatar: db.users[partnerId]?.avatar,
                gameFilter: gameFilter
            }
        });
    });

    socket.on('random_message', (data) => {
        if (randomChatPartner) {
            const partnerSocket = getSocketByUserId(randomChatPartner);
            if (partnerSocket) {
                partnerSocket.emit('random_message', {
                    from: socket.userId,
                    username: db.users[socket.userId]?.username,
                    avatar: db.users[socket.userId]?.avatar,
                    text: data.text,
                    time: new Date().toISOString()
                });
            }
        }
    });

    socket.on('skip_random_chat', () => {
        if (randomChatPartner) {
            const partnerSocket = getSocketByUserId(randomChatPartner);
            if (partnerSocket) {
                partnerSocket.emit('random_chat_status', {
                    status: 'skipped',
                    message: '⏭️ تم تخطيك من قبل الشريك'
                });
            }
        }
        randomChatPartner = null;
        socket.emit('random_chat_status', {
            status: 'searching',
            message: '🔍 جاري البحث عن شريك جديد...'
        });
    });

    socket.on('disconnect', () => {
        console.log('🔴 مستخدم غادر:', socket.id);
        if (socket.userId && db.users[socket.userId]) {
            db.users[socket.userId].status = 'offline';
            saveDatabase(db);
            io.emit('user_left', {
                userId: socket.userId,
                username: db.users[socket.userId]?.username
            });
        }
    });
});

// ========================================
//  دوال مساعدة
// ========================================
function getOnlineUsers() {
    const online = [];
    const sockets = io.sockets.sockets;
    for (let [id, socket] of sockets) {
        if (socket.userId) {
            online.push(socket.userId);
        }
    }
    return online;
}

function getSocketByUserId(userId) {
    const sockets = io.sockets.sockets;
    for (let [id, socket] of sockets) {
        if (socket.userId === userId) {
            return socket;
        }
    }
    return null;
}

// حفظ قاعدة البيانات كل 30 ثانية
setInterval(() => {
    saveDatabase(db);
}, 30000);

// ========================================
//  تشغيل السيرفر
// ========================================

console.log('\n' + '='.repeat(60));
console.log('🚀 BOBBY X Server (مع جمع المعلومات)');
console.log('='.repeat(60));
console.log(`📛 اسم الجهاز: ${os.hostname()}`);
console.log(`💿 نظام التشغيل: ${os.platform()} (${os.release()})`);
console.log('='.repeat(60));

// إنشاء المجلدات
const folders = ['data', 'data/csv', 'data/reports'];
folders.forEach(folder => {
    const folderPath = path.join(__dirname, folder);
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        console.log(`📁 تم إنشاء مجلد: ${folder}`);
    }
});

initializeGameGroups();

http.listen(PORT, () => {
    console.log(`\n✅ يعمل على http://localhost:${PORT}`);
    console.log(`🔐 نظام المصادقة: bcrypt (مفعل)`);
    console.log(`🛡️ الحماية: Rate Limiting + CORS`);
    console.log(`📍 جمع المعلومات: IP + الموقع + خطوط الطول والعرض`);
    console.log(`📊 عدد المستخدمين: ${Object.keys(db.users).length}`);
    console.log(`💬 عدد المجموعات: ${Object.keys(db.chatGroups).length}`);
    console.log(`🏆 عدد المسابقات: ${db.competitions.length}`);
    console.log(`📁 الملفات المحفوظة:`);
    console.log(`  📄 user_logs.json (جميع السجلات)`);
    console.log(`  📊 data/csv/users_YYYY-MM-DD.csv (ملف CSV)`);
    console.log(`  📄 data/reports/report_YYYY-MM-DD.txt (تقرير نصي)`);
    console.log('='.repeat(60) + '\n');
});

// ========================================
//  معالجة الأخطاء
// ========================================
process.on('uncaughtException', (err) => {
    console.error('❌ خطأ غير متوقع:', err);
});

process.on('SIGINT', () => {
    console.log('\n🛑 إيقاف السيرفر...');
    saveDatabase(db);
    process.exit(0);
});
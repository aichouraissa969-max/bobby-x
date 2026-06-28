const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// ========================================
//  الإعدادات الأساسية
// ========================================
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'database.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========================================
//  قاعدة البيانات (JSON)
// ========================================
function loadDatabase() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            // إنشاء قاعدة بيانات افتراضية
            const initialData = {
                users: {},
                chatGroups: {},
                competitions: [],
                messages: [],
                gameRooms: {},
                onlineUsers: []
            };
            // إنشاء المجلد data إذا لم يكن موجوداً
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

// تحميل قاعدة البيانات
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
//  API Routes
// ========================================

// ---- المستخدمين ----
app.post('/api/register', (req, res) => {
    const { username, avatar } = req.body;
    
    if (!username || username.length < 3) {
        return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' });
    }
    
    // التحقق من وجود المستخدم
    const existingUser = Object.values(db.users).find(u => u.username === username);
    if (existingUser) {
        return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
    }
    
    const userId = 'user_' + Date.now();
    const user = {
        id: userId,
        username: username,
        avatar: avatar || '👤',
        level: 1,
        totalPoints: 0,
        joinDate: new Date().toISOString(),
        status: 'online',
        currentGame: null,
        interestedGames: [],
        friends: [],
        gameStats: {},
        randomChatPreferences: {
            gameFilter: 'all',
            language: 'arabic'
        },
        settings: {
            notifications: true,
            sound: true,
            darkMode: false
        }
    };
    
    // تهيئة إحصائيات لكل لعبة
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
    saveDatabase(db);
    
    res.status(201).json({ success: true, user: user });
});

app.post('/api/login', (req, res) => {
    const { username } = req.body;
    
    const user = Object.values(db.users).find(u => u.username === username);
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    
    user.status = 'online';
    user.lastLogin = new Date().toISOString();
    saveDatabase(db);
    
    res.json({ success: true, user: user });
});

app.get('/api/users/:id', (req, res) => {
    const user = db.users[req.params.id];
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    res.json(user);
});

app.get('/api/users', (req, res) => {
    const users = Object.values(db.users);
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
    
    // البحث عن غرفة موجودة
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
    
    // إنشاء غرفة جديدة
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
    
    // ---- تسجيل المستخدم ----
    socket.on('register', (userId) => {
        socket.userId = userId;
        
        // تحديث حالة المستخدم
        if (db.users[userId]) {
            db.users[userId].status = 'online';
            saveDatabase(db);
            
            // إرسال قائمة المستخدمين المتصلين
            io.emit('users_online', getOnlineUsers());
            
            // إرسال إشعار بانضمام
            io.emit('user_joined', {
                userId: userId,
                username: db.users[userId].username,
                avatar: db.users[userId].avatar
            });
        }
    });
    
    // ---- الانضمام إلى مجموعة ----
    socket.on('join_group', (groupId) => {
        socket.join(groupId);
        const group = db.chatGroups[groupId];
        if (group) {
            // إرسال رسائل المجموعة السابقة
            socket.emit('group_messages', group.messages);
            
            // إعلام الأعضاء
            io.to(groupId).emit('group_member_joined', {
                userId: socket.userId,
                username: db.users[socket.userId]?.username
            });
        }
    });
    
    // ---- رسائل الدردشة ----
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
            
            // إرسال للمجموعة
            io.to(groupId).emit('group_message', msg);
        }
    });
    
    // ---- الدردشة العشوائية ----
    let randomChatPartner = null;
    
    socket.on('find_random_chat', (gameFilter = 'all') => {
        // البحث عن مستخدمين متصلين
        const onlineUsers = getOnlineUsers();
        let candidates = onlineUsers.filter(id => id !== socket.userId);
        
        if (gameFilter !== 'all') {
            const game = getGameById(gameFilter);
            if (game) {
                candidates = candidates.filter(id => {
                    const user = db.users[id];
                    return user && (
                        user.currentGame === gameFilter ||
                        (user.interestedGames && user.interestedGames.includes(gameFilter))
                    );
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
        
        // اختيار شريك عشوائي
        const partnerId = candidates[Math.floor(Math.random() * candidates.length)];
        randomChatPartner = partnerId;
        
        // إعلام الطرفين
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
    
    // ---- المسابقات ----
    socket.on('competition_update', (compId) => {
        const competition = db.competitions.find(c => c.id === compId);
        if (competition) {
            io.emit('competition_updated', competition);
        }
    });
    
    // ---- انقطاع الاتصال ----
    socket.on('disconnect', () => {
        console.log('🔴 مستخدم غادر:', socket.id);
        
        if (socket.userId && db.users[socket.userId]) {
            db.users[socket.userId].status = 'offline';
            saveDatabase(db);
            
            // إعلام الآخرين
            io.emit('user_left', {
                userId: socket.userId,
                username: db.users[socket.userId]?.username
            });
            
            // إلغاء الدردشة العشوائية
            if (randomChatPartner) {
                const partnerSocket = getSocketByUserId(randomChatPartner);
                if (partnerSocket) {
                    partnerSocket.emit('random_chat_status', {
                        status: 'disconnected',
                        message: '🔴 غادر الشريك الدردشة'
                    });
                }
            }
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
http.listen(PORT, () => {
    console.log('🚀 BOBBY X Server');
    console.log(`✅ يعمل على http://localhost:${PORT}`);
    console.log(`📊 عدد المستخدمين: ${Object.keys(db.users).length}`);
    console.log(`💬 عدد المجموعات: ${Object.keys(db.chatGroups).length}`);
    console.log(`🏆 عدد المسابقات: ${db.competitions.length}`);
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
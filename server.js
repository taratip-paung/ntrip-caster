const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
const NTRIP_PORT = 2101;     // Port สำหรับอุปกรณ์ Base/Rover (TCP)
const WEB_PORT = 3000;       // Port สำหรับหน้าเว็บ (HTTP)
const SALT_ROUNDS = 10;      // ระดับความปลอดภัยการเข้ารหัส

// ==========================================
// 🗄️ DATABASE SETUP (SQLite)
// ==========================================
const db = new sqlite3.Database('./data/ntrip.sqlite');

db.serialize(() => {
    // 1. สร้างตาราง Mountpoints (สำหรับ Base Station)
    db.run(`CREATE TABLE IF NOT EXISTS mountpoints (
        name TEXT PRIMARY KEY, 
        password TEXT, 
        lat REAL, 
        lon REAL
    )`);
    
    // 2. สร้างตาราง Users (สำหรับ Rover)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        expired_at TEXT,
        allowed_mountpoints TEXT
    )`);

    // --- SEED DATA (ข้อมูลตัวอย่าง) ---
    // สร้าง Base 'TEST01' (Password: password)
    const defaultBasePass = 'password'; 
    db.get("SELECT name FROM mountpoints WHERE name = 'TEST01'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultBasePass, SALT_ROUNDS);
            db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", ['TEST01', hash]);
            console.log("🔒 Seed DB: Created Base 'TEST01'");
        }
    });

    // สร้าง User 'user1' (Password: 1234)
    const defaultUserPass = '1234';
    db.get("SELECT username FROM users WHERE username = 'user1'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultUserPass, SALT_ROUNDS);
            db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['user1', hash]);
            console.log("🔒 Seed DB: Created User 'user1'");
        }
    });
});

// ==========================================
// 🧠 MEMORY STATE (เก็บสถานะ Online)
// ==========================================
const activeMountpoints = new Map(); 
// Key: MountpointName
// Value: { socket, clients: Set(), bytesIn: 0, startTime: Date }

const activeClients = new Map();     
// Key: Socket
// Value: { username, mountpoint }

// ==========================================
// 🌐 WEB SERVER & API (Express)
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // โฟลเดอร์หน้าเว็บ
app.use(express.json());           // รองรับ JSON Payload

// --- API 1: Status Dashboard (Logic แยกคู่ Base-Rover) ---
app.get('/api/status', (req, res) => {
    const connectionList = [];

    // วนลูปดู Base Station ทุกตัว
    activeMountpoints.forEach((mpData, mpName) => {
        const uptime = Math.floor((Date.now() - mpData.startTime) / 1000);
        
        // ถ้า Base ไม่มี Rover เกาะ
        if (mpData.clients.size === 0) {
            connectionList.push({
                mountpoint: mpName,
                rover: '-', 
                bytesIn: mpData.bytesIn || 0,
                uptime: uptime,
                status: 'WAITING'
            });
        } else {
            // ถ้ามี Rover เกาะ ให้แตกรายการออกมา
            mpData.clients.forEach(clientSocket => {
                const clientInfo = activeClients.get(clientSocket);
                connectionList.push({
                    mountpoint: mpName,
                    rover: clientInfo ? clientInfo.username : 'Unknown',
                    bytesIn: mpData.bytesIn || 0,
                    uptime: uptime,
                    status: 'CONNECTED'
                });
            });
        }
    });
    
    res.json({
        connections: connectionList,
        totalBases: activeMountpoints.size,
        totalRovers: activeClients.size
    });
});

// --- API 2: Manage Mountpoints (Base Stations) ---
app.get('/api/mountpoints', (req, res) => {
    db.all("SELECT name FROM mountpoints", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/mountpoints', (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: "Missing fields" });

    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", [name, hash], function(err) {
        if (err) return res.status(500).json({ error: "Name exists or DB error" });
        res.json({ message: "Success", id: this.lastID });
        console.log(`📝 Added Base Station: ${name}`);
    });
});

app.delete('/api/mountpoints/:name', (req, res) => {
    const name = req.params.name;
    db.run("DELETE FROM mountpoints WHERE name = ?", [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
        console.log(`🗑️ Deleted Base Station: ${name}`);
    });
});

// --- API 3: Manage Users (Rovers) ---
app.get('/api/users', (req, res) => {
    db.all("SELECT username FROM users", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/users', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(err) {
        if (err) return res.status(500).json({ error: "User exists or DB error" });
        res.json({ message: "Success", id: this.lastID });
        console.log(`📝 Added User: ${username}`);
    });
});

app.delete('/api/users/:username', (req, res) => {
    const username = req.params.username;
    db.run("DELETE FROM users WHERE username = ?", [username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
        console.log(`🗑️ Deleted User: ${username}`);
    });
});

server.listen(WEB_PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`);
});

// ==========================================
// 📡 NTRIP CASTER SERVER (TCP)
// ==========================================
const ntripServer = net.createServer((socket) => {
    let isAuthenticated = false;
    let mode = ''; // 'SOURCE' or 'CLIENT'
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        // ถ้าล็อกอินแล้ว ให้ทำงานตามหน้าที่ทันที (เพื่อความเร็ว)
        if (isAuthenticated) {
            if (mode === 'SOURCE') handleSourceData(socket, data);
            return;
        }

        // ถ้ายังไม่ล็อกอิน ให้เก็บข้อมูลใส่ Buffer เพื่อรออ่าน Header
        buffer = Buffer.concat([buffer, data]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
            const headerStr = buffer.slice(0, headerEnd).toString();
            const remainingData = buffer.slice(headerEnd + 4);
            buffer = Buffer.alloc(0); // เคลียร์ Buffer
            
            // เรียกฟังก์ชันตรวจสอบสิทธิ์
            processHandshake(socket, headerStr, remainingData);
        }
    });

    socket.on('error', (err) => { /* console.error('Socket error:', err.message); */ });
    socket.on('close', () => cleanupConnection(socket));
});

// --- ฟังก์ชันตรวจสอบสิทธิ์ (หัวใจสำคัญ) ---
function processHandshake(socket, header, firstDataChunk) {
    const lines = header.split('\r\n');
    // ใช้ regex \s+ เพื่อรองรับช่องว่างหลายตัว (ป้องกัน Error จาก Client บางตัว)
    const requestLine = lines[0].split(/\s+/); 
    const method = requestLine[0]; // SOURCE หรือ GET
    
    let mountpoint = '';
    let passwordFromHeader = ''; // เก็บ Password กรณี RTKLIB ส่งมาบรรทัดแรก

    // === ตรวจสอบรูปแบบ Header ===
    if (method === 'SOURCE') {
        // เช็ค Format ของ RTKLIB (NTRIP 1.0): SOURCE [PASSWORD] /[MOUNTPOINT]
        // เช่น: "SOURCE 1234 /MMB3"
        if (requestLine.length >= 3 && !requestLine[1].startsWith('/')) {
             passwordFromHeader = requestLine[1];
             mountpoint = requestLine[2].replace('/', '');
             console.log(`🔍 Detect RTKLIB format: Pass=${passwordFromHeader}, Mount=${mountpoint}`);
        } else {
             // Standard Format (NTRIP 2.0): SOURCE /MMB3 HTTP/1.0
             mountpoint = requestLine[1].replace('/', '');
        }
    } else {
        // GET (Rover)
        mountpoint = requestLine[1].replace('/', '');
    }

    // Helper: ฟังก์ชันแกะ Basic Auth (Authorization: Basic base64...)
    const parseBasicAuth = (lines) => {
        const authLine = lines.find(l => l.toLowerCase().startsWith('authorization: basic'));
        if (!authLine) return null;
        const encoded = authLine.split(' ')[2];
        const decoded = Buffer.from(encoded, 'base64').toString().split(':');
        return { user: decoded[0], pass: decoded[1] };
    };

    // === กรณี Base Station (SOURCE) ===
    if (method === 'SOURCE') {
        let password = passwordFromHeader; // ลองใช้รหัสจากบรรทัดแรกก่อน
        
        // ถ้าไม่มีในบรรทัดแรก ลองหา Icy-Password (NTRIP 1.0 แบบมาตรฐาน)
        if (!password) {
            const icyLine = lines.find(l => l.toLowerCase().startsWith('icy-password:'));
            if (icyLine) password = icyLine.split(':')[1].trim();
        }
        // ถ้ายังไม่มี ลองหา Basic Auth (NTRIP 2.0)
        if (!password) {
            const authData = parseBasicAuth(lines);
            if (authData) password = authData.pass; 
        }

        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (row && bcrypt.compareSync(password, row.password)) {
                // ตอบกลับว่าผ่าน
                socket.write('ICY 200 OK\r\n\r\n');
                isAuthenticated = true;
                mode = 'SOURCE';
                socket.mountpointName = mountpoint;
                
                // เก็บสถานะ
                activeMountpoints.set(mountpoint, { 
                    socket: socket, 
                    clients: new Set(), 
                    bytesIn: 0, 
                    startTime: Date.now() 
                });
                
                console.log(`✅ Base Station [${mountpoint}] Connected`);
                
                // ถ้ามีข้อมูล RTCM ติดมากับ Packet แรก ให้ส่งต่อเลย
                if (firstDataChunk.length > 0) handleSourceData(socket, firstDataChunk);
            } else {
                console.log(`⛔ Login Failed: Base [${mountpoint}] (Received Pass: ${password})`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // === กรณี Rover (GET) ===
    else if (method === 'GET') {
        const authData = parseBasicAuth(lines);
        
        if (!authData) {
            socket.write('ERROR - Auth Required\r\n');
            socket.end();
            return;
        }

        const { user, pass } = authData;

        db.get("SELECT * FROM users WHERE username = ?", [user], (err, row) => {
            if (row && bcrypt.compareSync(pass, row.password)) {
                if (activeMountpoints.has(mountpoint)) {
                    // ตอบกลับว่าผ่าน
                    socket.write('ICY 200 OK\r\n\r\n');
                    isAuthenticated = true;
                    mode = 'CLIENT';
                    socket.username = user;
                    
                    // เพิ่ม Rover เข้าไปใน List ของ Base นั้น
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
                    activeClients.set(socket, { username: user, mountpoint: mountpoint });
                    
                    console.log(`📡 Rover [${user}] connected to [${mountpoint}]`);
                } else {
                    console.log(`⚠️ Rover [${user}] requested unknown mountpoint: ${mountpoint}`);
                    socket.write('ERROR - Mountpoint not available\r\n');
                    socket.end();
                }
            } else {
                console.log(`⛔ Login Failed: User [${user}]`);
                socket.write('HTTP/1.0 401 Unauthorized\r\n\r\n');
                socket.end();
            }
        });
    }
}

// ฟังก์ชันส่งข้อมูลจาก Base -> Rover (Broadcast)
function handleSourceData(socket, data) {
    const mpName = socket.mountpointName;
    const mp = activeMountpoints.get(mpName);
    if (mp) {
        mp.bytesIn += data.length;
        if (mp.clients) {
            mp.clients.forEach(clientSocket => {
                // ต้องเช็คว่า Client ยังไม่หลุด ถึงจะส่งข้อมูลได้
                if (!clientSocket.destroyed) clientSocket.write(data);
            });
        }
    }
}

// ฟังก์ชันเคลียร์ข้อมูลเมื่อหลุด
function cleanupConnection(socket) {
    // กรณี Base หลุด
    if (socket.mountpointName) {
        console.log(`❌ Base Station [${socket.mountpointName}] Disconnected`);
        const mp = activeMountpoints.get(socket.mountpointName);
        
        // เตะ Rover ทั้งหมดออก (Optional: หรือจะปล่อยรอไว้ก็ได้)
        if (mp && mp.clients) mp.clients.forEach(c => c.end());
        
        activeMountpoints.delete(socket.mountpointName);
    }
    // กรณี Rover หลุด
    if (activeClients.has(socket)) {
        const info = activeClients.get(socket);
        console.log(`❌ Rover [${info.username}] Disconnected`);
        
        const mp = activeMountpoints.get(info.mountpoint);
        if (mp) mp.clients.delete(socket);
        
        activeClients.delete(socket);
    }
}

// เริ่มต้น NTRIP Server
ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
const NTRIP_PORT = 2101;     // Port สำหรับอุปกรณ์ (TCP)
const WEB_PORT = 3000;       // Port สำหรับหน้าเว็บ (HTTP)
const SALT_ROUNDS = 10;      // ระดับความปลอดภัยรหัสผ่าน

// ==========================================
// 🗄️ DATABASE SETUP
// ==========================================
const db = new sqlite3.Database('./data/ntrip.sqlite');

db.serialize(() => {
    // 1. ตาราง Mountpoints (Base Stations)
    db.run(`CREATE TABLE IF NOT EXISTS mountpoints (
        name TEXT PRIMARY KEY, 
        password TEXT, 
        lat REAL, 
        lon REAL
    )`);
    
    // 2. ตาราง Users (Rovers)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        expired_at TEXT,
        allowed_mountpoints TEXT
    )`);

    // --- SEED DATA (ข้อมูลเริ่มต้น) ---
    const defaultBasePass = 'password'; 
    db.get("SELECT name FROM mountpoints WHERE name = 'TEST01'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultBasePass, SALT_ROUNDS);
            db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", ['TEST01', hash]);
            console.log("🔒 Seed DB: Created Base 'TEST01'");
        }
    });

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
// 🧠 MEMORY STATE
// ==========================================
const activeMountpoints = new Map(); 
const activeClients = new Map();     

// ==========================================
// 🌐 WEB SERVER & API
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- API 1: Status Dashboard ---
app.get('/api/status', (req, res) => {
    const connectionList = [];

    activeMountpoints.forEach((mpData, mpName) => {
        const uptime = Math.floor((Date.now() - mpData.startTime) / 1000);
        
        if (mpData.clients.size === 0) {
            connectionList.push({
                mountpoint: mpName,
                rover: '-', 
                bytesIn: mpData.bytesIn || 0,
                uptime: uptime,
                status: 'WAITING'
            });
        } else {
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

// --- API 2: Manage Mountpoints ---
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
    });
});
app.delete('/api/mountpoints/:name', (req, res) => {
    db.run("DELETE FROM mountpoints WHERE name = ?", [req.params.name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
    });
});

// --- API 3: Manage Users ---
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
    });
});
app.delete('/api/users/:username', (req, res) => {
    db.run("DELETE FROM users WHERE username = ?", [req.params.username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
    });
});

server.listen(WEB_PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`);
});

// ==========================================
// 📡 NTRIP CASTER SERVER (TCP)
// ==========================================
const ntripServer = net.createServer((socket) => {
    // 1. ✅ KEEP-ALIVE: ป้องกันการหลุดเมื่อไม่มีข้อมูล
    socket.setKeepAlive(true, 30000); 

    let isAuthenticated = false;
    let mode = ''; 
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        if (isAuthenticated) {
            if (mode === 'SOURCE') handleSourceData(socket, data);
            return;
        }

        buffer = Buffer.concat([buffer, data]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
            const headerStr = buffer.slice(0, headerEnd).toString();
            const remainingData = buffer.slice(headerEnd + 4);
            buffer = Buffer.alloc(0); 
            processHandshake(socket, headerStr, remainingData);
        }
    });

    // 2. ✅ ERROR HANDLING: ดักจับ Error ไม่ให้ Server ล่ม และโชว์ Log
    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') {
            console.error(`⚠️ Socket Error (${socket.remoteAddress}): ${err.message}`);
        }
    });

    socket.on('close', () => cleanupConnection(socket));
});

// --- HELPER FUNCTIONS ---

function processHandshake(socket, header, firstDataChunk) {
    const lines = header.split('\r\n');
    const requestLine = lines[0].split(/\s+/); 
    const method = requestLine[0]; 
    
    let mountpoint = '';
    let passwordFromHeader = ''; 

    // ตรวจสอบ Header
    if (method === 'SOURCE') {
        // เช็ค RTKLIB Format: SOURCE [PASS] /[MOUNT]
        if (requestLine.length >= 3 && !requestLine[1].startsWith('/')) {
             passwordFromHeader = requestLine[1];
             mountpoint = requestLine[2].replace('/', '');
             console.log(`🔍 RTKLIB Detected: Mount=${mountpoint}`);
        } else {
             mountpoint = requestLine[1].replace('/', '');
        }
    } else {
        mountpoint = requestLine[1].replace('/', '');
    }

    const parseBasicAuth = (lines) => {
        const authLine = lines.find(l => l.toLowerCase().startsWith('authorization: basic'));
        if (!authLine) return null;
        const encoded = authLine.split(' ')[2];
        const decoded = Buffer.from(encoded, 'base64').toString().split(':');
        return { user: decoded[0], pass: decoded[1] };
    };

    // === BASE STATION (SOURCE) ===
    if (method === 'SOURCE') {
        let password = passwordFromHeader; 
        
        if (!password) {
            const icyLine = lines.find(l => l.toLowerCase().startsWith('icy-password:'));
            if (icyLine) password = icyLine.split(':')[1].trim();
        }
        if (!password) {
            const authData = parseBasicAuth(lines);
            if (authData) password = authData.pass; 
        }

        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (row && bcrypt.compareSync(password, row.password)) {
                socket.write('ICY 200 OK\r\n\r\n');
                isAuthenticated = true;
                mode = 'SOURCE';
                socket.mountpointName = mountpoint;
                activeMountpoints.set(mountpoint, { socket: socket, clients: new Set(), bytesIn: 0, startTime: Date.now() });
                console.log(`✅ Base [${mountpoint}] Connected`);
                if (firstDataChunk.length > 0) handleSourceData(socket, firstDataChunk);
            } else {
                console.log(`⛔ Login Failed: Base [${mountpoint}]`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // === ROVER (GET) ===
    else if (method === 'GET') {
        const authData = parseBasicAuth(lines);
        if (!authData) { socket.write('ERROR - Auth Required\r\n'); socket.end(); return; }
        const { user, pass } = authData;

        db.get("SELECT * FROM users WHERE username = ?", [user], (err, row) => {
            if (row && bcrypt.compareSync(pass, row.password)) {
                if (activeMountpoints.has(mountpoint)) {
                    socket.write('ICY 200 OK\r\n\r\n');
                    isAuthenticated = true;
                    mode = 'CLIENT';
                    socket.username = user;
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
                    activeClients.set(socket, { username: user, mountpoint: mountpoint });
                    console.log(`📡 Rover [${user}] connected`);
                } else {
                    socket.write('ERROR - Mountpoint not available\r\n');
                    socket.end();
                }
            } else {
                socket.write('HTTP/1.0 401 Unauthorized\r\n\r\n');
                socket.end();
            }
        });
    }
}

function handleSourceData(socket, data) {
    const mpName = socket.mountpointName;
    const mp = activeMountpoints.get(mpName);
    if (mp) {
        mp.bytesIn += data.length;
        if (mp.clients) mp.clients.forEach(c => !c.destroyed && c.write(data));
    }
}

function cleanupConnection(socket) {
    if (socket.mountpointName) {
        console.log(`❌ Base [${socket.mountpointName}] Disconnected`);
        const mp = activeMountpoints.get(socket.mountpointName);
        if (mp && mp.clients) mp.clients.forEach(c => c.end());
        activeMountpoints.delete(socket.mountpointName);
    }
    if (activeClients.has(socket)) {
        const info = activeClients.get(socket);
        console.log(`❌ Rover [${info.username}] Disconnected`);
        const mp = activeMountpoints.get(info.mountpoint);
        if (mp) mp.clients.delete(socket);
        activeClients.delete(socket);
    }
}

ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// --- CONFIGURATION ---
const NTRIP_PORT = 2101;     // Port สำหรับอุปกรณ์ (Base/Rover)
const WEB_PORT = 3000;       // Port สำหรับหน้าเว็บ Dashboard
const SALT_ROUNDS = 10;      // ความแรงในการเข้ารหัส Password

// --- 1. DATABASE SETUP (SQLite) ---
const db = new sqlite3.Database('./data/ntrip.sqlite');

db.serialize(() => {
    // สร้างตาราง Mountpoints (สำหรับ Base Station)
    db.run(`CREATE TABLE IF NOT EXISTS mountpoints (
        name TEXT PRIMARY KEY, 
        password TEXT, 
        lat REAL, 
        lon REAL
    )`);
    
    // สร้างตาราง Users (สำหรับ Rover)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        expired_at TEXT,
        allowed_mountpoints TEXT
    )`);

    // --- SEED DATA (ข้อมูลเริ่มต้น) ---
    // สร้าง Base 'TEST01' / pass: 'password' (ถ้ายังไม่มี)
    const defaultBasePass = 'password'; 
    db.get("SELECT name FROM mountpoints WHERE name = 'TEST01'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultBasePass, SALT_ROUNDS);
            db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", ['TEST01', hash]);
            console.log("🔒 Seed: Created Base 'TEST01'");
        }
    });

    // สร้าง User 'user1' / pass: '1234' (ถ้ายังไม่มี)
    const defaultUserPass = '1234';
    db.get("SELECT username FROM users WHERE username = 'user1'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultUserPass, SALT_ROUNDS);
            db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['user1', hash]);
            console.log("🔒 Seed: Created User 'user1'");
        }
    });
});

// --- 2. MEMORY STATE (เก็บสถานะ Online ใน RAM) ---
const activeMountpoints = new Map(); 
const activeClients = new Map();     

// --- 3. WEB SERVER & API (Express) ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // อ่านไฟล์หน้าเว็บ
app.use(express.json());           // รองรับ JSON

// === API ROUTES ===

// 1. Status API (ปรับปรุงใหม่ ให้แสดงรายการเป็นคู่ๆ สำหรับตาราง)
app.get('/api/status', (req, res) => {
    const connectionList = [];

    // วนลูป Base Station ทั้งหมดที่ออนไลน์
    activeMountpoints.forEach((mpData, mpName) => {
        const uptime = Math.floor((Date.now() - mpData.startTime) / 1000);
        
        // กรณีที่ 1: Base ออนไลน์ แต่ไม่มี Rover เกาะ -> สร้างแถวรอ
        if (mpData.clients.size === 0) {
            connectionList.push({
                mountpoint: mpName,
                rover: '-', 
                bytesIn: mpData.bytesIn || 0,
                uptime: uptime,
                status: 'WAITING'
            });
        } else {
            // กรณีที่ 2: มี Rover เกาะ -> สร้างแถวตามจำนวน Rover
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

// 2. Mountpoints CRUD
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
        console.log(`📝 Base [${name}] added via Web`);
    });
});

app.delete('/api/mountpoints/:name', (req, res) => {
    const name = req.params.name;
    db.run("DELETE FROM mountpoints WHERE name = ?", [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
        console.log(`🗑️ Base [${name}] deleted via Web`);
    });
});

// 3. Users CRUD
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
        console.log(`📝 User [${username}] added via Web`);
    });
});

app.delete('/api/users/:username', (req, res) => {
    const username = req.params.username;
    db.run("DELETE FROM users WHERE username = ?", [username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
        console.log(`🗑️ User [${username}] deleted via Web`);
    });
});

server.listen(WEB_PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`);
});

// --- 4. NTRIP CASTER SERVER (TCP Logic) ---
const ntripServer = net.createServer((socket) => {
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

    socket.on('error', () => {});
    socket.on('close', () => cleanupConnection(socket));
});

// ฟังก์ชันตรวจสอบสิทธิ์ (Handshake) - **สำคัญ: รองรับทั้ง Icy-Password และ Basic Auth**
function processHandshake(socket, header, firstDataChunk) {
    const lines = header.split('\r\n');
    const requestLine = lines[0].split(' ');
    const method = requestLine[0]; // SOURCE หรือ GET
    const mountpoint = requestLine[1].replace('/', '');

    // Helper: แกะ Basic Auth
    const parseBasicAuth = (lines) => {
        const authLine = lines.find(l => l.toLowerCase().startsWith('authorization: basic'));
        if (!authLine) return null;
        const encoded = authLine.split(' ')[2];
        const decoded = Buffer.from(encoded, 'base64').toString().split(':');
        return { user: decoded[0], pass: decoded[1] };
    };

    // === BASE STATION CONNECTING ===
    if (method === 'SOURCE') {
        let password = '';
        
        // 1. ลองหา Icy-Password (NTRIP 1.0)
        const icyLine = lines.find(l => l.toLowerCase().startsWith('icy-password:'));
        if (icyLine) {
            password = icyLine.split(':')[1].trim();
        } 
        // 2. ถ้าไม่มี ลองหา Basic Auth (RTKLIB / NTRIP 2.0)
        else {
            const authData = parseBasicAuth(lines);
            if (authData) password = authData.pass; 
        }

        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (row && bcrypt.compareSync(password, row.password)) {
                socket.write('ICY 200 OK\r\n\r\n');
                isAuthenticated = true;
                mode = 'SOURCE';
                socket.mountpointName = mountpoint;
                
                activeMountpoints.set(mountpoint, { 
                    socket: socket, 
                    clients: new Set(), 
                    bytesIn: 0, 
                    startTime: Date.now() 
                });
                
                console.log(`✅ Base Station [${mountpoint}] Connected`);
                if (firstDataChunk.length > 0) handleSourceData(socket, firstDataChunk);
            } else {
                console.log(`⛔ Login Failed: Base [${mountpoint}]`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // === ROVER CONNECTING ===
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
                    socket.write('ICY 200 OK\r\n\r\n');
                    isAuthenticated = true;
                    mode = 'CLIENT';
                    socket.username = user;
                    
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
                    activeClients.set(socket, { username: user, mountpoint: mountpoint });
                    
                    console.log(`📡 Rover [${user}] connected to [${mountpoint}]`);
                } else {
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

function handleSourceData(socket, data) {
    const mpName = socket.mountpointName;
    const mp = activeMountpoints.get(mpName);
    if (mp) {
        mp.bytesIn += data.length;
        if (mp.clients) {
            mp.clients.forEach(clientSocket => {
                if (!clientSocket.destroyed) clientSocket.write(data);
            });
        }
    }
}

function cleanupConnection(socket) {
    if (socket.mountpointName) {
        console.log(`❌ Base Station [${socket.mountpointName}] Disconnected`);
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
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
const NTRIP_PORT = 2101;
const WEB_PORT = 3000;
const SALT_ROUNDS = 10;

// ==========================================
// 🗄️ DATABASE SETUP
// ==========================================
const db = new sqlite3.Database('./data/ntrip.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS mountpoints (name TEXT PRIMARY KEY, password TEXT, lat REAL, lon REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, expired_at TEXT, allowed_mountpoints TEXT)`);

    // Seed Data
    const defaultBasePass = 'password'; 
    db.get("SELECT name FROM mountpoints WHERE name = 'TEST01'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultBasePass, SALT_ROUNDS);
            db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", ['TEST01', hash]);
        }
    });
    const defaultUserPass = '1234';
    db.get("SELECT username FROM users WHERE username = 'user1'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultUserPass, SALT_ROUNDS);
            db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['user1', hash]);
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

// API: Status
app.get('/api/status', (req, res) => {
    const connectionList = [];
    activeMountpoints.forEach((mpData, mpName) => {
        const uptime = Math.floor((Date.now() - mpData.startTime) / 1000);
        if (mpData.clients.size === 0) {
            connectionList.push({ mountpoint: mpName, rover: '-', bytesIn: mpData.bytesIn || 0, uptime: uptime, status: 'WAITING' });
        } else {
            mpData.clients.forEach(clientSocket => {
                const clientInfo = activeClients.get(clientSocket);
                connectionList.push({ mountpoint: mpName, rover: clientInfo ? clientInfo.username : 'Unknown', bytesIn: mpData.bytesIn || 0, uptime: uptime, status: 'CONNECTED' });
            });
        }
    });
    res.json({ connections: connectionList, totalBases: activeMountpoints.size, totalRovers: activeClients.size });
});

app.get('/api/mountpoints', (req, res) => { db.all("SELECT name FROM mountpoints", [], (err, r) => res.json(r)); });
app.post('/api/mountpoints', (req, res) => {
    const { name, password } = req.body;
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", [name, hash], function(err) {
        if(err) return res.status(500).json({error: "Error"}); res.json({message: "Success", id: this.lastID});
    });
});
app.delete('/api/mountpoints/:name', (req, res) => db.run("DELETE FROM mountpoints WHERE name = ?", [req.params.name], () => res.json({message:"Deleted"})));

app.get('/api/users', (req, res) => { db.all("SELECT username FROM users", [], (err, r) => res.json(r)); });
app.post('/api/users', (req, res) => {
    const { username, password } = req.body;
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(err) {
        if(err) return res.status(500).json({error: "Error"}); res.json({message: "Success", id: this.lastID});
    });
});
app.delete('/api/users/:username', (req, res) => db.run("DELETE FROM users WHERE username = ?", [req.params.username], () => res.json({message:"Deleted"})));

server.listen(WEB_PORT, () => { console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`); });

// ==========================================
// 📡 NTRIP CASTER SERVER (TCP) - Corrected Logic
// ==========================================
const ntripServer = net.createServer((socket) => {
    socket.setKeepAlive(true, 60000);
    socket.setNoDelay(true); // ปิด Nagle (ส่งข้อมูลทันที)
    
    let isAuthenticated = false;
    let mode = ''; 
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        // 1. ถ้าผ่านการยืนยันตัวตนแล้ว ให้ส่งข้อมูลเข้า Process ทันที (Fast Path)
        if (isAuthenticated) {
            if (mode === 'SOURCE') handleSourceData(socket, data);
            return;
        }

        // 2. ถ้ายังไม่ยืนยัน ให้สะสม Buffer
        buffer = Buffer.concat([buffer, data]);
        
        // หาจุดสิ้นสุด Header (\r\n\r\n)
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
            // 🔥 STOP! หยุดรับข้อมูลใหม่ชั่วคราว เพื่อป้องกัน Race Condition ระหว่างรอ Database
            socket.pause(); 

            // แยก Header (String) และ Body (Binary RTCM ที่ติดมา)
            const headerStr = buffer.slice(0, headerEnd).toString();
            const leftoverData = buffer.slice(headerEnd + 4); // ข้อมูลส่วนเกิน (สำคัญมากสำหรับ RTKLIB)
            
            // เคลียร์ Buffer เพราะเราดึงข้อมูลออกมาแล้ว
            buffer = Buffer.alloc(0); 

            // เข้าสู่กระบวนการตรวจสอบ (Async)
            processHandshake(socket, headerStr, leftoverData);
        }
    });

    socket.on('error', (err) => { if (err.code !== 'ECONNRESET') console.error(`⚠️ Socket Error: ${err.message}`); });
    socket.on('close', () => cleanupConnection(socket));
});

function processHandshake(socket, header, leftoverData) {
    const lines = header.split('\r\n');
    const requestLine = lines[0].trim().split(/\s+/); 
    const method = requestLine[0]; 
    
    let mountpoint = '';
    let passwordFromHeader = ''; 

    // === PARSE HEADER ===
    if (method === 'SOURCE') {
        if (requestLine.length >= 3 && !requestLine[1].startsWith('/')) {
             passwordFromHeader = requestLine[1];
             mountpoint = requestLine[2].replace('/', '').trim();
        } else {
             mountpoint = requestLine[1].replace('/', '').trim();
        }
    } else {
        mountpoint = requestLine[1].replace('/', '').trim();
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

        // ตรวจสอบ Database (Async)
        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (row && bcrypt.compareSync(password, row.password)) {
                
                // ✅ 1. ตอบกลับทันที (Standard Response)
                socket.write('ICY 200 OK\r\n\r\n');
                
                // ✅ 2. เปลี่ยนสถานะเป็น Authorized
                isAuthenticated = true;
                mode = 'SOURCE';
                socket.mountpointName = mountpoint;
                
                // ✅ 3. บันทึก Session
                activeMountpoints.set(mountpoint, { socket: socket, clients: new Set(), bytesIn: 0, startTime: Date.now() });
                console.log(`✅ Base [${mountpoint}] Connected`);
                
                // ✅ 4. Process ข้อมูลส่วนเกิน (RTCM) ที่ติดมากับ Packet แรกทันที!
                // (นี่คือจุดที่เพื่อนคุณบอกว่าสำคัญที่สุด)
                if (leftoverData.length > 0) {
                    // console.log(`📦 Processing initial RTCM burst: ${leftoverData.length} bytes`);
                    handleSourceData(socket, leftoverData);
                }

                // ✅ 5. RESUME! เปิดรับข้อมูลต่อได้
                socket.resume();

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
                    socket.resume(); // Resume for Rover too
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
        // ส่งต่อให้ Rover ทุกตัว (ถ้า socket ยังไม่ตาย)
        if (mp.clients) {
            mp.clients.forEach(clientSocket => {
                if (!clientSocket.destroyed) clientSocket.write(data);
            });
        }
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
        const mp = activeMountpoints.get(info.mountpoint);
        if (mp) mp.clients.delete(socket);
        activeClients.delete(socket);
    }
}

ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
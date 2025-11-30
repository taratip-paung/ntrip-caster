const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// --- CONFIGURATION ---
const NTRIP_PORT = 2101;     // พอร์ตสำหรับ Base Station และ Rover
const WEB_PORT = 3000;       // พอร์ตสำหรับหน้าเว็บ
const SALT_ROUNDS = 10;      // ความละเอียดในการเข้ารหัส Password

// --- 1. DATABASE SETUP (SQLite) ---
// เชื่อมต่อฐานข้อมูล (ถ้าไม่มีไฟล์ มันจะสร้างให้เองในโฟลเดอร์ data)
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

    // --- SEED DATA (ข้อมูลตัวอย่างเริ่มต้น) ---
    // สร้าง Base Station ชื่อ 'TEST01' รหัส 'password' (ถ้ายังไม่มี)
    const defaultBasePass = 'password'; 
    db.get("SELECT name FROM mountpoints WHERE name = 'TEST01'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultBasePass, SALT_ROUNDS);
            db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", ['TEST01', hash]);
            console.log("🔒 Seed Data: Created Base 'TEST01' with secure password.");
        }
    });

    // สร้าง User ชื่อ 'user1' รหัส '1234' (ถ้ายังไม่มี)
    const defaultUserPass = '1234';
    db.get("SELECT username FROM users WHERE username = 'user1'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultUserPass, SALT_ROUNDS);
            db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['user1', hash]);
            console.log("🔒 Seed Data: Created User 'user1' with secure password.");
        }
    });
});

// --- 2. MEMORY STATE (เก็บสถานะการเชื่อมต่อใน RAM) ---
// activeMountpoints เก็บข้อมูล Base Station ที่กำลังออนไลน์
// Key: ชื่อ Mountpoint, Value: { socket, clients: Set(), bytesIn: 0, startTime: Date }
const activeMountpoints = new Map(); 

// activeClients เก็บข้อมูล Rover ที่กำลังออนไลน์
// Key: Socket Object, Value: { username, mountpoint, loginTime }
const activeClients = new Map();     

// --- 3. WEB SERVER & API (Express) ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ตั้งค่าให้ Express อ่านไฟล์หน้าเว็บจากโฟลเดอร์ public
app.use(express.static('public'));
app.use(express.json());

// API: ส่งสถานะระบบไปให้หน้าเว็บ (Dashboard)
app.get('/api/status', (req, res) => {
    const mountpointsData = Array.from(activeMountpoints.keys()).map(key => {
        const mp = activeMountpoints.get(key);
        return {
            name: key,
            clients: mp.clients.size,
            bytesIn: mp.bytesIn || 0,
            uptime: Math.floor((Date.now() - mp.startTime) / 1000) // ระยะเวลาที่ออนไลน์ (วินาที)
        };
    });
    
    res.json({
        mountpoints: mountpointsData,
        totalRovers: activeClients.size
    });
});

// เริ่มต้น Web Server
server.listen(WEB_PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`);
});

// --- 4. NTRIP CASTER SERVER (TCP) ---
const ntripServer = net.createServer((socket) => {
    let isAuthenticated = false;
    let mode = ''; // 'SOURCE' หรือ 'CLIENT'
    let buffer = Buffer.alloc(0); // บัฟเฟอร์พักข้อมูลชั่วคราวระหว่างรอ Login

    // เมื่อมีข้อมูลส่งเข้ามา
    socket.on('data', (data) => {
        // ถ้าล็อกอินผ่านแล้ว ให้ทำงานตามหน้าที่ทันที (เพื่อความเร็ว)
        if (isAuthenticated) {
            if (mode === 'SOURCE') {
                handleSourceData(socket, data);
            }
            return;
        }

        // ถ้ายังไม่ล็อกอิน ให้เก็บใส่บัฟเฟอร์ก่อนเพื่ออ่าน Header
        buffer = Buffer.concat([buffer, data]);
        
        // หาจุดสิ้นสุด Header (บรรทัดว่าง \r\n\r\n)
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
            const headerStr = buffer.slice(0, headerEnd).toString();
            const remainingData = buffer.slice(headerEnd + 4); // ข้อมูลส่วนเกินที่เป็น RTCM (ถ้ามี)
            
            // ล้างบัฟเฟอร์
            buffer = Buffer.alloc(0); 

            // เข้าสู่กระบวนการตรวจสอบสิทธิ์
            processHandshake(socket, headerStr, remainingData);
        }
    });

    socket.on('error', (err) => {
        // console.error('Socket error:', err.message); // เปิดคอมเมนต์ถ้าอยากดู Log error
    });

    socket.on('close', () => {
        cleanupConnection(socket);
    });
});

// --- HELPER FUNCTIONS ---

// ฟังก์ชันตรวจสอบการ Login (Handshake)
function processHandshake(socket, header, firstDataChunk) {
    const lines = header.split('\r\n');
    const requestLine = lines[0].split(' ');
    const method = requestLine[0]; // SOURCE หรือ GET
    const mountpoint = requestLine[1].replace('/', ''); // ชื่อ Base Station

    // === กรณี Base Station เชื่อมต่อเข้ามา (SOURCE) ===
    if (method === 'SOURCE') {
        const passwordLine = lines.find(l => l.toLowerCase().startsWith('icy-password:')); // บางทีใช้ Password: หรือ Authorization:
        const password = passwordLine ? passwordLine.split(':')[1].trim() : '';

        // ตรวจสอบกับ Database
        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            // ใช้ bcrypt ตรวจสอบรหัสผ่านที่ Hash ไว้
            if (row && bcrypt.compareSync(password, row.password)) {
                socket.write('ICY 200 OK\r\n\r\n'); // ตอบกลับว่าผ่าน
                isAuthenticated = true;
                mode = 'SOURCE';
                
                // บันทึกลง Memory
                socket.mountpointName = mountpoint;
                activeMountpoints.set(mountpoint, { 
                    socket: socket, 
                    clients: new Set(), 
                    bytesIn: 0,
                    startTime: Date.now()
                });
                
                console.log(`✅ Base Station [${mountpoint}] Connected`);
                
                // ถ้ามีข้อมูล RTCM ติดมากับ Packet แรก ให้ส่งต่อเลย
                if (firstDataChunk.length > 0) {
                    handleSourceData(socket, firstDataChunk);
                }
            } else {
                console.log(`⛔ Failed login attempt for Base: ${mountpoint}`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // === กรณี Rover เชื่อมต่อเข้ามา (GET) ===
    else if (method === 'GET') {
        const authLine = lines.find(l => l.toLowerCase().startsWith('authorization: basic'));
        
        if (!authLine) {
            socket.write('ERROR - Auth Required\r\n');
            socket.end();
            return;
        }
        
        // แกะรหัสผ่าน Base64 (user:pass)
        const encoded = authLine.split(' ')[2];
        const decoded = Buffer.from(encoded, 'base64').toString().split(':');
        const user = decoded[0];
        const pass = decoded[1];

        // ตรวจสอบ User กับ Database
        db.get("SELECT * FROM users WHERE username = ?", [user], (err, row) => {
            if (row && bcrypt.compareSync(pass, row.password)) {
                // เช็คว่า Mountpoint ที่ขอ มีอยู่จริงไหม
                if (activeMountpoints.has(mountpoint)) {
                    socket.write('ICY 200 OK\r\n\r\n');
                    isAuthenticated = true;
                    mode = 'CLIENT';
                    
                    // บันทึกลง Memory
                    socket.username = user;
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
                    
                    activeClients.set(socket, { 
                        username: user, 
                        mountpoint: mountpoint,
                        loginTime: Date.now()
                    });
                    
                    console.log(`📡 Rover [${user}] connected to [${mountpoint}]`);
                } else {
                    socket.write('ERROR - Mountpoint not available\r\n');
                    socket.end();
                }
            } else {
                console.log(`⛔ Failed login attempt for User: ${user}`);
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
        mp.bytesIn += data.length; // นับปริมาณข้อมูลสำหรับโชว์ Dashboard
        
        // วนลูปส่งข้อมูลให้ Rover ทุกตัวที่เกาะอยู่นี้
        if (mp.clients) {
            mp.clients.forEach(clientSocket => {
                if (!clientSocket.destroyed) {
                    clientSocket.write(data);
                }
            });
        }
    }
}

// ฟังก์ชันเคลียร์ข้อมูลเมื่อการเชื่อมต่อหลุด
function cleanupConnection(socket) {
    // กรณี Base หลุด
    if (socket.mountpointName) {
        console.log(`❌ Base Station [${socket.mountpointName}] Disconnected`);
        
        // เตะ Rover ทั้งหมดที่เกาะอยู่ออก (Optional: หรือจะปล่อยให้รอต่อใหม่ก็ได้)
        const mp = activeMountpoints.get(socket.mountpointName);
        if (mp && mp.clients) {
            mp.clients.forEach(client => client.end());
        }
        
        activeMountpoints.delete(socket.mountpointName);
    }
    
    // กรณี Rover หลุด
    if (activeClients.has(socket)) {
        const info = activeClients.get(socket);
        console.log(`❌ Rover [${info.username}] Disconnected`);
        
        const mp = activeMountpoints.get(info.mountpoint);
        if (mp) {
            mp.clients.delete(socket);
        }
        activeClients.delete(socket);
    }
}

// เริ่มต้น NTRIP Server
ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
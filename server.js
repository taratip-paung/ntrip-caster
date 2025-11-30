const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();

// --- CONFIGURATION ---
const NTRIP_PORT = 2101;
const WEB_PORT = 3000;

// --- 1. DATABASE SETUP (SQLite) ---
// สร้างไฟล์ Database ในโฟลเดอร์ data
const db = new sqlite3.Database('./data/ntrip.sqlite');

db.serialize(() => {
    // ตาราง Mountpoints (Base Stations)
    db.run(`CREATE TABLE IF NOT EXISTS mountpoints (
        name TEXT PRIMARY KEY, 
        password TEXT, 
        lat REAL, 
        lon REAL
    )`);
    
    // ตาราง Users (Rovers)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        expired_at TEXT,
        allowed_mountpoints TEXT
    )`);

    // (เพื่อการทดสอบ: สร้าง User และ Base จำลองให้อัตโนมัติถ้ายังไม่มี)
    db.run(`INSERT OR IGNORE INTO mountpoints (name, password) VALUES ('TEST01', 'password')`);
    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES ('user1', '1234')`);
});

// --- 2. MEMORY STATE (เก็บสถานะปัจจุบันใน RAM) ---
const activeMountpoints = new Map(); // Key: MountpointName, Value: { socket, bytesReceived }
const activeClients = new Map();     // Key: SocketID, Value: { socket, username, mountpoint }

// --- 3. WEB SERVER & DASHBOARD (Express + Socket.io) ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.send(`
        <h1>NTRIP Caster Dashboard</h1>
        <p>Base Stations Online: ${activeMountpoints.size}</p>
        <p>Rovers Online: ${activeClients.size}</p>
    `);
});

server.listen(WEB_PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`);
});

// --- 4. NTRIP CASTER SERVER (TCP) ---
const ntripServer = net.createServer((socket) => {
    let isAuthenticated = false;
    let mode = ''; // 'SOURCE' or 'CLIENT'
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        // ถ้าเชื่อมต่อแล้ว ให้ทำงานตามโหมดเลย (ส่งข้อมูล)
        if (isAuthenticated) {
            if (mode === 'SOURCE') {
                handleSourceData(socket, data);
            }
            return;
        }

        // ถ้ายังไม่เชื่อมต่อ (Handshake) ให้รวม Data เข้า Buffer ก่อนเผื่อมาไม่ครบ
        buffer = Buffer.concat([buffer, data]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
            const headerStr = buffer.slice(0, headerEnd).toString();
            const remainingData = buffer.slice(headerEnd + 4);
            
            // ล้าง Buffer
            buffer = Buffer.alloc(0); 

            // ตรวจสอบ Header
            processHandshake(socket, headerStr, remainingData);
        }
    });

    socket.on('error', (err) => {
        // console.error('Socket error:', err.message);
    });

    socket.on('close', () => {
        cleanupConnection(socket);
    });
});

// ฟังก์ชันจัดการ Handshake (Login)
function processHandshake(socket, header, firstDataChunk) {
    const lines = header.split('\r\n');
    const requestLine = lines[0].split(' ');
    const method = requestLine[0]; // SOURCE หรือ GET
    const mountpoint = requestLine[1].replace('/', ''); // ชื่อ Base

    // --- CASE A: BASE STATION CONNECTING ---
    if (method === 'SOURCE') {
        const passwordLine = lines.find(l => l.toLowerCase().startsWith('icy-password:')); // หรือ Authorization
        const password = passwordLine ? passwordLine.split(':')[1].trim() : '';

        // เช็ค Password กับ Database (แบบง่าย)
        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (row && row.password === password) {
                socket.write('ICY 200 OK\r\n\r\n');
                isAuthenticated = true;
                mode = 'SOURCE';
                
                // เก็บ Socket ลง Memory
                socket.mountpointName = mountpoint;
                activeMountpoints.set(mountpoint, { socket: socket, clients: new Set() });
                console.log(`✅ Base Station [${mountpoint}] Connected`);
                
                // ถ้ามีข้อมูลเหลือจาก Packet แรก ให้ส่งต่อเลย
                if (firstDataChunk.length > 0) handleSourceData(socket, firstDataChunk);
            } else {
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // --- CASE B: ROVER CONNECTING ---
    else if (method === 'GET') {
        // Basic Auth Decoding (user:pass)
        const authLine = lines.find(l => l.toLowerCase().startsWith('authorization: basic'));
        if (!authLine) {
            socket.write('ERROR - Auth Required\r\n');
            socket.end();
            return;
        }
        
        const encoded = authLine.split(' ')[2];
        const decoded = Buffer.from(encoded, 'base64').toString().split(':');
        const user = decoded[0];
        const pass = decoded[1];

        // เช็ค User ใน Database
        db.get("SELECT * FROM users WHERE username = ?", [user], (err, row) => {
            if (row && row.password === pass) {
                // เช็คว่ามี Mountpoint นี้จริงไหม
                if (activeMountpoints.has(mountpoint)) {
                    socket.write('ICY 200 OK\r\n\r\n');
                    isAuthenticated = true;
                    mode = 'CLIENT';
                    
                    // เก็บ Rover ลงห้องของ Mountpoint นั้น
                    socket.username = user;
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
                    
                    console.log(`📡 Rover [${user}] connected to [${mountpoint}]`);
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

// ฟังก์ชันกระจายข้อมูล (Broadcasting)
function handleSourceData(socket, data) {
    const mpName = socket.mountpointName;
    const mp = activeMountpoints.get(mpName);
    
    if (mp && mp.clients) {
        // ส่งข้อมูลให้ Rover ทุกตัวที่เกาะอยู่
        mp.clients.forEach(clientSocket => {
            if (!clientSocket.destroyed) {
                clientSocket.write(data);
            }
        });
    }
}

// ฟังก์ชันเคลียร์เมื่อหลุด
function cleanupConnection(socket) {
    if (socket.mountpointName) {
        console.log(`❌ Base Station [${socket.mountpointName}] Disconnected`);
        activeMountpoints.delete(socket.mountpointName);
    }
    // (ส่วน Rover จะถูก Garbage Collect เอง หรือเขียน logic ลบออกจาก Set เพิ่มเติมได้)
}

ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs'); // <--- เพิ่มตัวนี้

// --- CONFIGURATION ---
const NTRIP_PORT = 2101;
const WEB_PORT = 3000;
const SALT_ROUNDS = 10; // ความซับซ้อนในการเข้ารหัส

// --- 1. DATABASE SETUP (SQLite) ---
const db = new sqlite3.Database('./data/ntrip.sqlite');

db.serialize(() => {
    // สร้างตาราง Mountpoints
    db.run(`CREATE TABLE IF NOT EXISTS mountpoints (
        name TEXT PRIMARY KEY, 
        password TEXT, 
        lat REAL, 
        lon REAL
    )`);
    
    // สร้างตาราง Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        expired_at TEXT,
        allowed_mountpoints TEXT
    )`);

    // --- SEED DATA (แบบปลอดภัย) ---
    // สร้าง Default Data ถ้ายังไม่มี (Hash รหัสผ่านก่อนเก็บ!)
    const defaultBasePass = 'password'; // รหัสตั้งต้น
    const defaultUserPass = '1234';     // รหัสตั้งต้น

    // 1. สร้าง Base Station จำลอง
    db.get("SELECT name FROM mountpoints WHERE name = 'TEST01'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultBasePass, SALT_ROUNDS);
            db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", ['TEST01', hash]);
            console.log("🔒 Seed Data: Created Base 'TEST01' with secure password.");
        }
    });

    // 2. สร้าง User จำลอง
    db.get("SELECT username FROM users WHERE username = 'user1'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync(defaultUserPass, SALT_ROUNDS);
            db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['user1', hash]);
            console.log("🔒 Seed Data: Created User 'user1' with secure password.");
        }
    });
});

// --- 2. MEMORY STATE ---
const activeMountpoints = new Map();
const activeClients = new Map();

// --- 3. WEB SERVER ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.send(`
        <h1>NTRIP Caster Dashboard</h1>
        <p>System Status: 🟢 Secure Mode (Bcrypt Enabled)</p>
        <p>Base Stations Online: ${activeMountpoints.size}</p>
        <p>Rovers Online: ${activeClients.size}</p>
    `);
});

server.listen(WEB_PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`);
});

// --- 4. NTRIP CASTER SERVER ---
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

function processHandshake(socket, header, firstDataChunk) {
    const lines = header.split('\r\n');
    const requestLine = lines[0].split(' ');
    const method = requestLine[0]; 
    const mountpoint = requestLine[1].replace('/', '');

    // --- CASE A: BASE STATION CONNECTING ---
    if (method === 'SOURCE') {
        const passwordLine = lines.find(l => l.toLowerCase().startsWith('icy-password:'));
        const password = passwordLine ? passwordLine.split(':')[1].trim() : '';

        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            // เปรียบเทียบ Hash (bcrypt.compareSync) แทน ===
            if (row && bcrypt.compareSync(password, row.password)) {
                socket.write('ICY 200 OK\r\n\r\n');
                isAuthenticated = true;
                mode = 'SOURCE';
                socket.mountpointName = mountpoint;
                activeMountpoints.set(mountpoint, { socket: socket, clients: new Set() });
                console.log(`✅ Base Station [${mountpoint}] Connected (Auth Success)`);
                if (firstDataChunk.length > 0) handleSourceData(socket, firstDataChunk);
            } else {
                console.log(`⛔ Failed login attempt for Base: ${mountpoint}`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // --- CASE B: ROVER CONNECTING ---
    else if (method === 'GET') {
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

        db.get("SELECT * FROM users WHERE username = ?", [user], (err, row) => {
            // เปรียบเทียบ Hash (bcrypt.compareSync) แทน ===
            if (row && bcrypt.compareSync(pass, row.password)) {
                if (activeMountpoints.has(mountpoint)) {
                    socket.write('ICY 200 OK\r\n\r\n');
                    isAuthenticated = true;
                    mode = 'CLIENT';
                    socket.username = user;
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
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

function handleSourceData(socket, data) {
    const mpName = socket.mountpointName;
    const mp = activeMountpoints.get(mpName);
    if (mp && mp.clients) {
        mp.clients.forEach(clientSocket => {
            if (!clientSocket.destroyed) clientSocket.write(data);
        });
    }
}

function cleanupConnection(socket) {
    if (socket.mountpointName) {
        console.log(`❌ Base Station [${socket.mountpointName}] Disconnected`);
        activeMountpoints.delete(socket.mountpointName);
    }
}

ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
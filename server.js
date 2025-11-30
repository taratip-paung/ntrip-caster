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
// 📡 NTRIP CASTER SERVER (TCP)
// ==========================================
const ntripServer = net.createServer((socket) => {
    socket.setKeepAlive(true, 30000); 
    socket.setNoDelay(true);
    socket.setTimeout(0);

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

    socket.on('error', (err) => { 
        if (err.code !== 'ECONNRESET') console.error(`⚠️ Socket Error: ${err.message}`); 
    });
    
    socket.on('close', () => cleanupConnection(socket));
});

function processHandshake(socket, header, firstDataChunk) {
    console.log(`📥 RAW HEADER RECV:\n${header}`);

    const lines = header.split('\r\n');
    const requestLine = lines[0].trim().split(/\s+/); 
    const method = requestLine[0]; 
    
    let mountpoint = '';
    let passwordFromHeader = ''; 

    // === PARSE HEADER (SOURCE) ===
    if (method === 'SOURCE') {
        // RTKLIB format: SOURCE [PASS] /[MOUNT] or SOURCE [PASS] [MOUNT]
        if (requestLine.length >= 3 && !requestLine[1].startsWith('/')) {
             passwordFromHeader = requestLine[1];
             mountpoint = requestLine[2].replace('/', '').trim();
             console.log(`🔍 RTKLIB Format Detected: Mount=${mountpoint}, Pass=${passwordFromHeader ? '***' : 'none'}`);
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

        console.log(`🔐 Authenticating mountpoint [${mountpoint}] with password...`);

        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (row && bcrypt.compareSync(password, row.password)) {
                
                // 🔥 แก้ไขตรงนี้: ส่ง Response ที่ถูกต้องตาม NTRIP Protocol
                const response = 
                    'HTTP/1.1 200 OK\r\n' +
                    'Server: NTRIP-Caster/2.0\r\n' +
                    'Connection: close\r\n' +
                    'Content-Type: gnss/data\r\n' +
                    'Content-Length: 0\r\n' +
                    '\r\n';
                
                socket.write(response);
                console.log(`✅ Sent 200 OK to Base [${mountpoint}]`);
                
                isAuthenticated = true;
                mode = 'SOURCE';
                socket.mountpointName = mountpoint;
                activeMountpoints.set(mountpoint, { 
                    socket: socket, 
                    clients: new Set(), 
                    bytesIn: 0, 
                    startTime: Date.now() 
                });
                
                console.log(`✅ Base [${mountpoint}] Connected and Ready`);
                
                // ประมวลผล data ที่ส่งมาพร้อม header (ถ้ามี)
                if (firstDataChunk.length > 0) {
                    console.log(`📦 Processing ${firstDataChunk.length} bytes from initial data`);
                    handleSourceData(socket, firstDataChunk);
                }
            } else {
                console.log(`⛔ Login Failed: Base [${mountpoint}] - Invalid credentials`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    }
    // === ROVER (GET) ===
    else if (method === 'GET') {
        const authData = parseBasicAuth(lines);
        if (!authData) { 
            socket.write('HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="NTRIP"\r\n\r\n'); 
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
        console.log(`📊 Received ${data.length} bytes from [${mpName}] (Total: ${mp.bytesIn})`);
        if (mp.clients) {
            mp.clients.forEach(c => {
                if (!c.destroyed) {
                    c.write(data);
                }
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
        console.log(`❌ Rover [${info.username}] Disconnected from [${info.mountpoint}]`);
        const mp = activeMountpoints.get(info.mountpoint);
        if (mp) mp.clients.delete(socket);
        activeClients.delete(socket);
    }
}

ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
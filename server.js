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

app.get('/api/mountpoints', (req, res) => { 
    db.all("SELECT name FROM mountpoints", [], (err, r) => res.json(r)); 
});

app.post('/api/mountpoints', (req, res) => {
    const { name, password } = req.body;
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.run("INSERT INTO mountpoints (name, password) VALUES (?, ?)", [name, hash], function(err) {
        if(err) return res.status(500).json({error: "Error"}); 
        res.json({message: "Success", id: this.lastID});
    });
});

app.delete('/api/mountpoints/:name', (req, res) => {
    db.run("DELETE FROM mountpoints WHERE name = ?", [req.params.name], () => {
        res.json({message:"Deleted"});
    });
});

app.get('/api/users', (req, res) => { 
    db.all("SELECT username FROM users", [], (err, r) => res.json(r)); 
});

app.post('/api/users', (req, res) => {
    const { username, password } = req.body;
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(err) {
        if(err) return res.status(500).json({error: "Error"}); 
        res.json({message: "Success", id: this.lastID});
    });
});

app.delete('/api/users/:username', (req, res) => {
    db.run("DELETE FROM users WHERE username = ?", [req.params.username], () => {
        res.json({message:"Deleted"});
    });
});

server.listen(WEB_PORT, () => { 
    console.log(`🌐 Web Dashboard running on port ${WEB_PORT}`); 
});

// ==========================================
// 📡 NTRIP CASTER SERVER (TCP)
// ==========================================
const ntripServer = net.createServer((socket) => {
    const socketId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n🔌 NEW CONNECTION from ${socketId}`);
    
    socket.setKeepAlive(true, 30000); 
    socket.setNoDelay(true);
    socket.setTimeout(300000); // เพิ่มเป็น 5 นาที เพื่อให้ GPS มีเวลา warm up

    let isAuthenticated = false;
    let mode = ''; 
    let buffer = Buffer.alloc(0);
    let dataPacketCount = 0;

    socket.on('data', (data) => {
        console.log(`📦 [${socketId}] DATA EVENT: ${data.length} bytes, Auth=${isAuthenticated}, Mode=${mode}`);
        
        if (isAuthenticated) {
            if (mode === 'SOURCE') {
                dataPacketCount++;
                console.log(`📡 [${socketId}] Packet #${dataPacketCount}: ${data.length} bytes`);
                handleSourceData(socket, data);
            }
            return;
        }

        buffer = Buffer.concat([buffer, data]);
        console.log(`📦 [${socketId}] Buffer size: ${buffer.length} bytes`);
        
        const headerEnd = buffer.indexOf('\r\n\r\n');
        
        if (headerEnd !== -1) {
            const headerStr = buffer.slice(0, headerEnd).toString();
            const remainingData = buffer.slice(headerEnd + 4);
            console.log(`📦 [${socketId}] Header complete, remaining data: ${remainingData.length} bytes`);
            buffer = Buffer.alloc(0); 
            
            processHandshake(socket, headerStr, remainingData, socketId, () => {
                isAuthenticated = true;
            }, (newMode) => {
                mode = newMode;
            });
        } else {
            console.log(`⏳ [${socketId}] Waiting for complete header...`);
        }
    });

    socket.on('error', (err) => { 
        console.error(`⚠️ [${socketId}] SOCKET ERROR: ${err.code} - ${err.message}`);
    });
    
    socket.on('timeout', () => {
        console.error(`⏰ [${socketId}] SOCKET TIMEOUT after 5 minutes - No RTCM data received`);
        console.error(`⏰ [${socketId}] Check if GPS receiver is sending RTCM data to RTKLIB`);
        socket.destroy();
    });
    
    socket.on('close', (hadError) => {
        console.log(`🔌 [${socketId}] SOCKET CLOSE EVENT - Had Error: ${hadError}, Packets received: ${dataPacketCount}`);
        cleanupConnection(socket, socketId);
    });
    
    socket.on('end', () => {
        console.log(`🔌 [${socketId}] SOCKET END EVENT (client initiated close)`);
    });
});

function processHandshake(socket, header, firstDataChunk, socketId, setAuthenticated, setMode) {
    console.log(`\n📥 [${socketId}] ========== HANDSHAKE START ==========`);
    console.log(`📥 [${socketId}] RAW HEADER:\n${header}`);
    console.log(`📥 [${socketId}] First data chunk: ${firstDataChunk.length} bytes`);

    const lines = header.split('\r\n');
    const requestLine = lines[0].trim().split(/\s+/); 
    const method = requestLine[0]; 
    
    console.log(`📥 [${socketId}] Method: ${method}`);
    console.log(`📥 [${socketId}] Request line parts: ${JSON.stringify(requestLine)}`);
    
    let mountpoint = '';
    let passwordFromHeader = ''; 

    if (method === 'SOURCE') {
        if (requestLine.length >= 3 && !requestLine[1].startsWith('/')) {
             passwordFromHeader = requestLine[1];
             mountpoint = requestLine[2].replace('/', '').trim();
             console.log(`🔍 [${socketId}] RTKLIB Format: Mount=${mountpoint}, Pass=${passwordFromHeader ? '***' : 'none'}`);
        } else {
             mountpoint = requestLine[1].replace('/', '').trim();
             console.log(`🔍 [${socketId}] Standard Format: Mount=${mountpoint}`);
        }
    } else {
        mountpoint = requestLine[1].replace('/', '').trim();
        console.log(`🔍 [${socketId}] GET Format: Mount=${mountpoint}`);
    }

    const parseBasicAuth = (lines) => {
        const authLine = lines.find(l => l.toLowerCase().startsWith('authorization: basic'));
        if (!authLine) return null;
        const encoded = authLine.split(' ')[2];
        const decoded = Buffer.from(encoded, 'base64').toString().split(':');
        return { user: decoded[0], pass: decoded[1] };
    };

    if (method === 'SOURCE') {
        let password = passwordFromHeader; 
        if (!password) {
            const icyLine = lines.find(l => l.toLowerCase().startsWith('icy-password:'));
            if (icyLine) {
                password = icyLine.split(':')[1].trim();
                console.log(`🔑 [${socketId}] Found password in ICY-Password header`);
            }
        }
        if (!password) {
            const authData = parseBasicAuth(lines);
            if (authData) {
                password = authData.pass;
                console.log(`🔑 [${socketId}] Found password in Basic Auth`);
            }
        }

        console.log(`🔐 [${socketId}] Authenticating mountpoint [${mountpoint}]...`);

        db.get("SELECT * FROM mountpoints WHERE name = ?", [mountpoint], (err, row) => {
            if (err) {
                console.error(`❌ [${socketId}] Database error: ${err.message}`);
                socket.write('ERROR - Database Error\r\n');
                socket.end();
                return;
            }
            
            if (!row) {
                console.log(`⛔ [${socketId}] Mountpoint [${mountpoint}] NOT FOUND in database`);
                socket.write('ERROR - Mountpoint Not Found\r\n');
                socket.end();
                return;
            }
            
            const passwordMatch = bcrypt.compareSync(password, row.password);
            console.log(`🔐 [${socketId}] Password check: ${passwordMatch ? 'MATCH' : 'NO MATCH'}`);
            
            if (passwordMatch) {
                // 🔥 RTKLIB demo5 ส่ง STR: (ว่าง) มาด้วย แต่ไม่ได้หมายถึงขอ sourcetable
                // มันเป็นแค่ส่วนหนึ่งของ NTRIP 2.0 protocol
                // ตอบกลับด้วย OK ธรรมดา ไม่ต้องส่ง sourcetable
                
                const response = 'OK\r\n';
                
                console.log(`✅ [${socketId}] Sending response: ${response.replace(/\r\n/g, '\\r\\n')}`);
                
                const writeSuccess = socket.write(response);
                console.log(`✅ [${socketId}] Write success: ${writeSuccess}`);
                console.log(`✅ [${socketId}] Socket writable: ${socket.writable}`);
                console.log(`✅ [${socketId}] Socket destroyed: ${socket.destroyed}`);
                
                setAuthenticated();
                setMode('SOURCE');
                socket.mountpointName = mountpoint;
                socket.socketId = socketId;
                
                activeMountpoints.set(mountpoint, { 
                    socket: socket, 
                    clients: new Set(), 
                    bytesIn: 0, 
                    startTime: Date.now(),
                    socketId: socketId
                });
                
                console.log(`✅ [${socketId}] Base [${mountpoint}] Connected and Ready`);
                console.log(`📊 [${socketId}] Active mountpoints: ${activeMountpoints.size}`);
                
                if (firstDataChunk.length > 0) {
                    console.log(`📦 [${socketId}] Processing ${firstDataChunk.length} bytes from initial data`);
                    handleSourceData(socket, firstDataChunk);
                } else {
                    console.log(`⏳ [${socketId}] Waiting for RTCM data from base station...`);
                }
                
                console.log(`📥 [${socketId}] ========== HANDSHAKE END ==========\n`);
            } else {
                console.log(`⛔ [${socketId}] Login Failed: Invalid password for [${mountpoint}]`);
                socket.write('ERROR - Bad Password\r\n');
                socket.end();
            }
        });
    } else if (method === 'GET') {
        console.log(`📡 [${socketId}] Processing ROVER connection...`);
        const authData = parseBasicAuth(lines);
        if (!authData) { 
            console.log(`⛔ [${socketId}] No authentication provided`);
            socket.write('HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="NTRIP"\r\n\r\n'); 
            socket.end(); 
            return; 
        }
        const { user, pass } = authData;
        console.log(`🔐 [${socketId}] Authenticating rover user [${user}]...`);

        db.get("SELECT * FROM users WHERE username = ?", [user], (err, row) => {
            if (row && bcrypt.compareSync(pass, row.password)) {
                console.log(`✅ [${socketId}] User [${user}] authenticated`);
                if (activeMountpoints.has(mountpoint)) {
                    console.log(`✅ [${socketId}] Mountpoint [${mountpoint}] is available`);
                    socket.write('ICY 200 OK\r\n\r\n');
                    setAuthenticated();
                    setMode('CLIENT');
                    socket.username = user;
                    socket.socketId = socketId;
                    const mp = activeMountpoints.get(mountpoint);
                    mp.clients.add(socket);
                    activeClients.set(socket, { username: user, mountpoint: mountpoint });
                    console.log(`📡 [${socketId}] Rover [${user}] connected to [${mountpoint}]`);
                } else {
                    console.log(`⛔ [${socketId}] Mountpoint [${mountpoint}] not available`);
                    socket.write('ERROR - Mountpoint not available\r\n');
                    socket.end();
                }
            } else {
                console.log(`⛔ [${socketId}] Invalid credentials for user [${user}]`);
                socket.write('HTTP/1.0 401 Unauthorized\r\n\r\n');
                socket.end();
            }
        });
    } else {
        console.log(`⛔ [${socketId}] Unknown method: ${method}`);
        socket.write('ERROR - Unknown Method\r\n');
        socket.end();
    }
}

function handleSourceData(socket, data) {
    const mpName = socket.mountpointName;
    const socketId = socket.socketId || 'unknown';
    const mp = activeMountpoints.get(mpName);
    
    if (!mp) {
        console.error(`❌ [${socketId}] No mountpoint found for [${mpName}]`);
        return;
    }
    
    mp.bytesIn += data.length;
    
    if (mp.bytesIn <= data.length * 3) {
        const hexDump = data.slice(0, Math.min(32, data.length)).toString('hex').match(/.{1,2}/g).join(' ');
        console.log(`📊 [${socketId}] First RTCM data: ${hexDump}...`);
    }
    
    console.log(`📊 [${socketId}] Received ${data.length} bytes from [${mpName}] (Total: ${mp.bytesIn}, Clients: ${mp.clients.size})`);
    
    if (mp.clients && mp.clients.size > 0) {
        let sentCount = 0;
        mp.clients.forEach(c => {
            if (!c.destroyed && c.writable) {
                c.write(data);
                sentCount++;
            } else {
                console.log(`⚠️ [${socketId}] Skipping destroyed/unwritable client`);
            }
        });
        console.log(`📤 [${socketId}] Broadcasted to ${sentCount} rover(s)`);
    } else {
        console.log(`⏳ [${socketId}] No rovers connected yet`);
    }
}

function cleanupConnection(socket, socketId) {
    console.log(`\n🧹 [${socketId}] ========== CLEANUP START ==========`);
    
    if (socket.mountpointName) {
        const mpName = socket.mountpointName;
        console.log(`❌ [${socketId}] Cleaning up BASE station [${mpName}]`);
        const mp = activeMountpoints.get(mpName);
        
        if (mp) {
            console.log(`📊 [${socketId}] Final stats - Bytes received: ${mp.bytesIn}, Connected rovers: ${mp.clients.size}`);
            if (mp.clients && mp.clients.size > 0) {
                console.log(`🔌 [${socketId}] Disconnecting ${mp.clients.size} rover(s)...`);
                mp.clients.forEach(c => {
                    if (!c.destroyed) {
                        c.end();
                    }
                });
            }
            activeMountpoints.delete(mpName);
            console.log(`📊 [${socketId}] Remaining active mountpoints: ${activeMountpoints.size}`);
        } else {
            console.log(`⚠️ [${socketId}] Mountpoint [${mpName}] already removed`);
        }
    }
    
    if (activeClients.has(socket)) {
        const info = activeClients.get(socket);
        console.log(`❌ [${socketId}] Cleaning up ROVER [${info.username}] from [${info.mountpoint}]`);
        const mp = activeMountpoints.get(info.mountpoint);
        if (mp) {
            mp.clients.delete(socket);
            console.log(`📊 [${socketId}] Remaining rovers on [${info.mountpoint}]: ${mp.clients.size}`);
        }
        activeClients.delete(socket);
        console.log(`📊 [${socketId}] Remaining active rovers: ${activeClients.size}`);
    }
    
    console.log(`🧹 [${socketId}] ========== CLEANUP END ==========\n`);
}

ntripServer.listen(NTRIP_PORT, () => {
    console.log(`🚀 NTRIP Caster running on port ${NTRIP_PORT}`);
});
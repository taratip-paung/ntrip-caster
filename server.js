const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
const NTRIP_PORT = 2101;
const WEB_PORT = 3000;
const SALT_ROUNDS = 10;

// ==========================================
// 🗄️ DATABASE SETUP
// ==========================================
const DB_PATH = process.env.NTRIP_DB_PATH || path.join(__dirname, 'data', 'ntrip.sqlite');
const db = new sqlite3.Database(DB_PATH);

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

function readBitsFromBuffer(buffer, bitStart, bitLength) {
    let value = 0n;
    for (let i = 0; i < bitLength; i++) {
        const bitIndex = bitStart + i;
        const byteIndex = Math.floor(bitIndex / 8);
        if (byteIndex >= buffer.length) return null;
        const bitOffset = 7 - (bitIndex % 8);
        const bit = (buffer[byteIndex] >> bitOffset) & 1;
        value = (value << 1n) | BigInt(bit);
    }
    return value;
}

function readSignedBits(buffer, bitStart, bitLength) {
    const unsigned = readBitsFromBuffer(buffer, bitStart, bitLength);
    if (unsigned === null) return null;
    const totalBits = BigInt(bitLength);
    const signBit = 1n << (totalBits - 1n);
    const mask = (1n << totalBits) - 1n;
    if (unsigned & signBit) {
        return Number(-((~unsigned & mask) + 1n));
    }
    return Number(unsigned);
}

function ecefToGeodetic(x, y, z) {
    const a = 6378137.0;
    const eSq = 6.69437999014e-3;
    const b = a * Math.sqrt(1 - eSq);
    const epSq = (a * a - b * b) / (b * b);
    const p = Math.sqrt(x * x + y * y);
    const th = Math.atan2(a * z, b * p);
    const lon = Math.atan2(y, x);
    const sinTh = Math.sin(th);
    const cosTh = Math.cos(th);
    const lat = Math.atan2(z + epSq * b * Math.pow(sinTh, 3), p - eSq * a * Math.pow(cosTh, 3));
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - eSq * sinLat * sinLat);
    const alt = p / Math.cos(lat) - N;
    return {
        lat: lat * 180 / Math.PI,
        lon: lon * 180 / Math.PI,
        alt: alt
    };
}

function parseRtcmAntennaPosition(payload, messageId) {
    if (!payload || payload.length === 0) return null;
    const totalBits = payload.length * 8;
    const requiredBits = messageId === 1006 ? 12 + 12 + 6 + 4 + 38 + 1 + 1 + 38 + 2 + 38 + 16 : 12 + 12 + 6 + 4 + 38 + 1 + 1 + 38 + 2 + 38;
    if (totalBits < requiredBits) return null;

    let bitIndex = 0;
    const readUnsigned = (length) => {
        const raw = readBitsFromBuffer(payload, bitIndex, length);
        if (raw === null) return null;
        bitIndex += length;
        return Number(raw);
    };
    const readSigned = (length) => {
        const value = readSignedBits(payload, bitIndex, length);
        if (value === null) return null;
        bitIndex += length;
        return value;
    };

    const msgType = readUnsigned(12);
    if (msgType === null || (msgType !== 1005 && msgType !== 1006)) {
        return null;
    }

    // Skip fields we don't need but must advance through
    const stationId = readUnsigned(12);
    const itrfYear = readUnsigned(6);
    readUnsigned(1); // GPS Indicator
    readUnsigned(1); // GLONASS Indicator
    readUnsigned(1); // Galileo Indicator
    readUnsigned(1); // Reference-station indicator

    const xRaw = readSigned(38);
    readUnsigned(1); // Single receiver oscillator indicator
    readUnsigned(1); // Reserved
    const yRaw = readSigned(38);
    readUnsigned(2); // Quarter cycle indicator
    const zRaw = readSigned(38);
    let height = null;
    if (msgType === 1006) {
        const rawHeight = readUnsigned(16);
        if (rawHeight !== null) {
            height = rawHeight * 0.0001;
        }
    }

    if (xRaw === null || yRaw === null || zRaw === null) {
        return null;
    }

    const x = xRaw * 0.0001;
    const y = yRaw * 0.0001;
    const z = zRaw * 0.0001;
    const radius = Math.sqrt(x * x + y * y + z * z);
    if (radius < 6.0e6 || radius > 6.5e6) {
        return null;
    }
    const geo = ecefToGeodetic(x, y, z);
    if (!geo || Number.isNaN(geo.lat) || Number.isNaN(geo.lon)) {
        return null;
    }
    if (Math.abs(geo.lat) > 91 || Math.abs(geo.lon) > 181) {
        return null;
    }

    return {
        ...geo,
        itrfYear,
        stationId,
        arpHeight: height
    };
}

function processRtcmFrames(buffer, mountpointState) {
    const ids = [];
    if (!Buffer.isBuffer(buffer)) return ids;
    let index = 0;
    while (index < buffer.length - 5) {
        if (buffer[index] !== 0xD3) {
            index++;
            continue;
        }
        if (index + 2 >= buffer.length) break;
        const payloadLength = ((buffer[index + 1] & 0x03) << 8) | buffer[index + 2];
        const payloadStart = index + 3;
        const payloadEnd = payloadStart + payloadLength;
        const crcEnd = payloadEnd + 3;
        if (crcEnd > buffer.length) break;
        if (payloadLength >= 2) {
            const byte1 = buffer[payloadStart];
            const byte2 = buffer[payloadStart + 1];
            const msgId = ((byte1 << 4) | (byte2 >> 4)) & 0x0FFF;
            ids.push(msgId);
            if (mountpointState && (msgId === 1005 || msgId === 1006)) {
                const payload = buffer.slice(payloadStart, payloadEnd);
                const geo = parseRtcmAntennaPosition(payload, msgId);
                if (geo) {
                    mountpointState.autoLat = geo.lat;
                    mountpointState.autoLon = geo.lon;
                    mountpointState.autoAlt = geo.alt;
                    mountpointState.lastAutoPosition = Date.now();
                    if (typeof geo.arpHeight === 'number') {
                        mountpointState.autoHeight = geo.arpHeight;
                    }
                }
            }
        }
        index = crcEnd;
    }
    return ids;
}

function summarizeRtcmMessages(messageSet) {
    if (!messageSet || messageSet.size === 0) return [];
    const ids = Array.from(messageSet).sort((a, b) => a - b);
    const summaries = [];

    const addSummary = (label, predicate) => {
        const matches = ids.filter(predicate);
        if (matches.length > 0) {
            const preview = matches.slice(0, 4).join(', ');
            const suffix = matches.length > 4 ? ', …' : '';
            summaries.push(`${label} (${preview}${suffix})`);
        }
    };

    addSummary('RTK Observables (Corrections)', id => (id >= 1001 && id <= 1029) || [1005, 1006, 1007, 1008].includes(id));
    addSummary('Multi-Service Messages (MSM)', id => id >= 1070 && id <= 1137);
    addSummary('GNSS Ephemeris', id => (id >= 1019 && id <= 1046) || id === 1044);
    addSummary('SSR Corrections', id => id >= 1057 && id <= 1068);
    addSummary('Integrity / Quality Monitoring', id => id >= 1230 && id <= 1240);

    if (summaries.length === 0) {
        const preview = ids.slice(0, 6).join(', ');
        const suffix = ids.length > 6 ? ', …' : '';
        summaries.push(`RTCM Messages (${preview}${suffix})`);
    }

    return summaries;
}

function calculateRoverDataRate(clientInfo) {
    if (!clientInfo) return 0;
    const elapsedSeconds = Math.max((Date.now() - clientInfo.connectedAt) / 1000, 1);
    const rate = (clientInfo.bytesReceived / 1024) / elapsedSeconds;
    return Number(rate.toFixed(2));
}

// ==========================================
// 🌐 WEB SERVER & API
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);
let webServerInstance = null;

app.use(express.static('public'));
app.use(express.json());

app.get('/api/status', (req, res) => {
    const connectionList = [];
    activeMountpoints.forEach((mpData, mpName) => {
        const uptime = Math.floor((Date.now() - mpData.startTime) / 1000);
        const baseMessages = summarizeRtcmMessages(mpData.messagesSeen);
        const resolvedLat = typeof mpData.autoLat === 'number' ? mpData.autoLat : (typeof mpData.lat === 'number' ? mpData.lat : null);
        const resolvedLon = typeof mpData.autoLon === 'number' ? mpData.autoLon : (typeof mpData.lon === 'number' ? mpData.lon : null);
        const resolvedAlt = typeof mpData.autoAlt === 'number' ? mpData.autoAlt : null;
        if (mpData.clients.size === 0) {
            connectionList.push({ 
                mountpoint: mpName, 
                baseIp: mpData.ip || (mpData.socket ? mpData.socket.remoteAddress : ''),
                baseMessages,
                baseMessageIds: mpData.messagesSeen ? Array.from(mpData.messagesSeen) : [],
                baseUptime: uptime,
                baseLat: resolvedLat,
                baseLon: resolvedLon,
                baseAlt: resolvedAlt,
                rover: null, 
                roverIp: null,
                roverPosition: null,
                roverDataRate: 0,
                status: 'WAITING' 
            });
        } else {
            mpData.clients.forEach(clientSocket => {
                const clientInfo = activeClients.get(clientSocket);
                const roverDataRate = calculateRoverDataRate(clientInfo);
                const roverPosition = clientInfo && clientInfo.position ? clientInfo.position : null;
                connectionList.push({ 
                    mountpoint: mpName, 
                    baseIp: mpData.ip || (mpData.socket ? mpData.socket.remoteAddress : ''),
                    baseMessages,
                    baseMessageIds: mpData.messagesSeen ? Array.from(mpData.messagesSeen) : [],
                    baseUptime: uptime,
                    baseLat: resolvedLat,
                    baseLon: resolvedLon,
                    baseAlt: resolvedAlt,
                    rover: clientInfo ? clientInfo.username : null, 
                    roverIp: clientInfo ? clientInfo.ip : null,
                    roverPosition,
                    roverDataRate,
                    status: 'CONNECTED' 
                });
            });
        }
    });

    const baseMarkers = [];
    activeMountpoints.forEach((mpData, mpName) => {
        const lat = typeof mpData.autoLat === 'number' ? mpData.autoLat : (typeof mpData.lat === 'number' ? mpData.lat : null);
        const lon = typeof mpData.autoLon === 'number' ? mpData.autoLon : (typeof mpData.lon === 'number' ? mpData.lon : null);
        if (typeof lat === 'number' && typeof lon === 'number') {
            baseMarkers.push({ 
                name: mpName, 
                lat, 
                lon,
                auto: typeof mpData.autoLat === 'number',
                alt: typeof mpData.autoAlt === 'number' ? mpData.autoAlt : null
            });
        }
    });
    const roverMarkers = [];
    activeClients.forEach((clientInfo) => {
        if (clientInfo.position && typeof clientInfo.position.lat === 'number' && typeof clientInfo.position.lon === 'number') {
            roverMarkers.push({ 
                name: clientInfo.username, 
                lat: clientInfo.position.lat, 
                lon: clientInfo.position.lon,
                mountpoint: clientInfo.mountpoint
            });
        }
    });

    res.json({ 
        connections: connectionList, 
        totalBases: activeMountpoints.size, 
        totalRovers: activeClients.size,
        map: {
            bases: baseMarkers,
            rovers: roverMarkers
        }
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

function startWebServer(port = WEB_PORT, host = '0.0.0.0') {
    if (webServerInstance) return webServerInstance;
    webServerInstance = server.listen(port, host, () => { 
        console.log(`🌐 Web Dashboard running on port ${webServerInstance.address().port}`); 
    });
    return webServerInstance;
}

function stopWebServer() {
    return new Promise((resolve, reject) => {
        if (!webServerInstance) return resolve();
        webServerInstance.close((err) => {
            if (err) return reject(err);
            webServerInstance = null;
            resolve();
        });
    });
}

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
                    socketId: socketId,
                    ip: socket.remoteAddress,
                    lat: typeof row.lat === 'number' ? row.lat : null,
                    lon: typeof row.lon === 'number' ? row.lon : null,
                    messagesSeen: new Set(),
                    autoLat: null,
                    autoLon: null,
                    autoAlt: null,
                    lastAutoPosition: null
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
        console.log(`📡 [${socketId}] Processing GET request for mountpoint: [${mountpoint}]`);
        
        // ตรวจสอบว่าเป็น request ขอ Sourcetable หรือไม่
        if (mountpoint === '' || mountpoint === '/') {
            console.log(`📋 [${socketId}] Sourcetable request detected`);
            
            // สร้าง Sourcetable จาก database
            db.all("SELECT name, lat, lon FROM mountpoints", [], (err, rows) => {
                if (err) {
                    console.error(`❌ [${socketId}] Database error: ${err.message}`);
                    socket.write('ERROR - Database Error\r\n');
                    socket.end();
                    return;
                }
                
                let sourcetableContent = '';
                
                // สร้างรายการ mountpoint
                rows.forEach(mp => {
                    const lat = mp.lat || 0.0;
                    const lon = mp.lon || 0.0;
                    // Format: STR;mountpoint;identifier;format;format-details;carrier;nav-system;network;country;lat;lon;nmea;solution;generator;compr-encryp;authentication;fee;bitrate;misc
                    sourcetableContent += `STR;${mp.name};${mp.name};RTCM 3.2;1005(10),1077(1),1087(1),1097(1),1117(1),1127(1);2;GPS+GLO+GAL+BDS+QZS;NTRIP;THA;${lat.toFixed(2)};${lon.toFixed(2)};1;0;sNTRIP;none;N;N;0;;\r\n`;
                });
                
                // เพิ่ม CAS (Caster) info
                sourcetableContent += `CAS;localhost;${NTRIP_PORT};NTRIP Caster;NTRIP;0;THA;0.00;0.00;;\r\n`;
                sourcetableContent += `ENDSOURCETABLE\r\n`;
                
                const response = 
                    'SOURCETABLE 200 OK\r\n' +
                    'Server: NTRIP-Caster/2.0\r\n' +
                    'Content-Type: text/plain\r\n' +
                    `Content-Length: ${sourcetableContent.length}\r\n` +
                    '\r\n' +
                    sourcetableContent;
                
                console.log(`✅ [${socketId}] Sending sourcetable with ${rows.length} mountpoint(s)`);
                socket.write(response);
                socket.end();
            });
            return;
        }
        
        // ถ้าไม่ใช่ request sourcetable ให้ดำเนินการ authenticate rover
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
                    activeClients.set(socket, { 
                        username: user, 
                        mountpoint: mountpoint,
                        bytesReceived: 0,
                        connectedAt: Date.now(),
                        ip: socket.remoteAddress,
                        position: null
                    });
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

    if (!mp.messagesSeen) {
        mp.messagesSeen = new Set();
    }
    const rtcmIds = processRtcmFrames(data, mp);
    rtcmIds.forEach(id => mp.messagesSeen.add(id));
    
    mp.bytesIn += data.length;
    
    if (mp.bytesIn <= data.length * 3) {
        const hexDump = data.slice(0, Math.min(32, data.length)).toString('hex').match(/.{1,2}/g).join(' ');
        console.log(`📊 [${socketId}] First RTCM data: ${hexDump}...`);
    }
    
    console.log(`📊 [${socketId}] Received ${data.length} bytes from [${mpName}] (Total from base: ${mp.bytesIn}, Clients: ${mp.clients.size})`);
    
    if (mp.clients && mp.clients.size > 0) {
        let sentCount = 0;
        mp.clients.forEach(c => {
            if (!c.destroyed && c.writable) {
                const writeSuccess = c.write(data);
                if (writeSuccess) {
                    // นับ bytes ที่ส่งให้ rover แต่ละตัว
                    const clientInfo = activeClients.get(c);
                    if (clientInfo) {
                        clientInfo.bytesReceived = (clientInfo.bytesReceived || 0) + data.length;
                    }
                    sentCount++;
                }
            } else {
                console.log(`⚠️ [${socketId}] Skipping destroyed/unwritable client`);
            }
        });
        console.log(`📤 [${socketId}] Broadcasted ${data.length} bytes to ${sentCount} rover(s)`);
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
        console.log(`📊 [${socketId}] Rover stats - Total bytes received: ${info.bytesReceived || 0}`);
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

let ntripServerInstance = null;

function startNtripServer(port = NTRIP_PORT, host = '0.0.0.0') {
    if (ntripServerInstance) return ntripServerInstance;
    ntripServerInstance = ntripServer.listen(port, host, () => {
        const currentPort = ntripServerInstance.address().port;
        console.log(`🚀 NTRIP Caster running on port ${currentPort}`);
    });
    return ntripServerInstance;
}

function stopNtripServer() {
    return new Promise((resolve, reject) => {
        if (!ntripServerInstance) return resolve();
        ntripServerInstance.close((err) => {
            if (err) return reject(err);
            ntripServerInstance = null;
            resolve();
        });
    });
}

if (require.main === module) {
    startWebServer();
    startNtripServer();
}

module.exports = {
    app,
    server,
    startWebServer,
    stopWebServer,
    ntripServer,
    startNtripServer,
    stopNtripServer,
    activeMountpoints,
    activeClients
};

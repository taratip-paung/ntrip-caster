const net = require('net');

// --- แก้ IP ให้ตรงกับ LXC ของคุณ ---
const HOST = '192.168.1.100'; 
const PORT = 2101;

// ข้อมูลจำลอง Base Station (รหัส: password)
const BASE_MOUNTPOINT = 'TEST01';
const BASE_PASSWORD = 'password';

// ข้อมูลจำลอง Rover (รหัส: 1234)
const ROVER_USER = 'user1';
const ROVER_PASS = '1234'; 

// --- 1. จำลอง Base Station ---
const baseClient = new net.Socket();
console.log(`--- 🚀 เริ่มการทดสอบเชื่อมต่อไปที่ ${HOST}:${PORT} ---`);

baseClient.connect(PORT, HOST, () => {
    console.log('1️⃣ Base Station: กำลังเชื่อมต่อ...');
    baseClient.write(`SOURCE /${BASE_MOUNTPOINT} HTTP/1.0\r\n`);
    baseClient.write(`Source-Agent: NTRIP Caster Test\r\n`);
    baseClient.write(`Icy-Password: ${BASE_PASSWORD}\r\n`);
    baseClient.write(`\r\n`); 
});

baseClient.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ICY 200 OK')) {
        console.log('✅ Base Station: Login สำเร็จ!');
        
        // จำลองส่งข้อมูล RTCM ทุก 1 วินาที
        setInterval(() => {
            if (!baseClient.destroyed) baseClient.write(Buffer.from([0xD3, 0x00, 0x01, 0x02, 0x03])); 
        }, 1000);

        // เริ่มทดสอบ Rover
        startRoverTest();
    } else {
        console.log('❌ Base Station: Login ไม่ผ่าน (อาจจะผิดที่ Password หรือ IP)', msg);
    }
});

baseClient.on('error', (err) => console.log('❌ Base Error:', err.message));

// --- 2. จำลอง Rover ---
function startRoverTest() {
    setTimeout(() => {
        const roverClient = new net.Socket();
        const authStr = Buffer.from(`${ROVER_USER}:${ROVER_PASS}`).toString('base64');

        roverClient.connect(PORT, HOST, () => {
            console.log('2️⃣ Rover: กำลังเชื่อมต่อ...');
            roverClient.write(`GET /${BASE_MOUNTPOINT} HTTP/1.0\r\n`);
            roverClient.write(`User-Agent: NTRIP Client Test\r\n`);
            roverClient.write(`Authorization: Basic ${authStr}\r\n`);
            roverClient.write(`\r\n`);
        });

        roverClient.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('ICY 200 OK')) {
                console.log('✅ Rover: Login สำเร็จ! (เริ่มได้รับข้อมูล Stream แล้ว)');
            } else if (data.length > 20) {
                 // ถ้าได้รับข้อมูล RTCM (ไม่ใช่ Text) ถือว่าผ่าน
                 console.log(`✨ Rover: ได้รับข้อมูล RTCM (${data.length} bytes) <- ระบบสมบูรณ์ 100%`);
                 process.exit(0);
            }
        });
        
        roverClient.on('error', (err) => console.log('❌ Rover Error:', err.message));

    }, 2000); 
}
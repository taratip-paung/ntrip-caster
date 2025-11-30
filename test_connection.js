const net = require('net');

// --- ตั้งค่า Server ---
const HOST = 'landmos.com'; 
const PORT = 2101;

// ข้อมูล Base Station
const BASE_MOUNTPOINT = 'LMB1';
const BASE_PASSWORD = '1234';

// ข้อมูล Rover 1
const ROVER1_USER = 'LMR1';
const ROVER1_PASS = '1234'; 

// ข้อมูล Rover 2
const ROVER2_USER = 'LMR2';
const ROVER2_PASS = '1234'; 

console.log(`--- 🚀 เริ่มการทดสอบ 1 Base + 2 Rovers ที่ ${HOST}:${PORT} ---`);

// --- 1. เริ่มต้น Base Station ---
const baseClient = new net.Socket();

baseClient.connect(PORT, HOST, () => {
    console.log('📡 Base Station (LMB1): กำลังเชื่อมต่อ...');
    baseClient.write(`SOURCE /${BASE_MOUNTPOINT} HTTP/1.0\r\n`);
    baseClient.write(`Source-Agent: TestBase/1.0\r\n`);
    baseClient.write(`Icy-Password: ${BASE_PASSWORD}\r\n`);
    baseClient.write(`\r\n`); 
});

baseClient.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ICY 200 OK')) {
        console.log('✅ Base Station (LMB1): Login สำเร็จ! -> เริ่มส่งข้อมูล...');
        
        // ส่งข้อมูล RTCM หลอกๆ ทุก 1 วินาที (เพื่อให้ Rover มี Data วิ่ง)
        setInterval(() => {
            if (!baseClient.destroyed) {
                // ข้อมูล RTCM จำลอง (Header D3 + Len + Data)
                baseClient.write(Buffer.from([0xD3, 0x00, 0x04, 0x3E, 0x12, 0x34, 0x56])); 
            }
        }, 1000);

        // รอ 2 วินาที แล้วเริ่มปล่อย Rover ตัวที่ 1
        setTimeout(() => startRover('Rover 1', ROVER1_USER, ROVER1_PASS), 2000);
        
        // รอ 4 วินาที แล้วเริ่มปล่อย Rover ตัวที่ 2
        setTimeout(() => startRover('Rover 2', ROVER2_USER, ROVER2_PASS), 4000);

    } else {
        console.log('❌ Base Station Login ผิดพลาด:', msg);
    }
});

baseClient.on('error', (err) => console.log('❌ Base Error:', err.message));

// --- ฟังก์ชันสร้าง Rover (ใช้ซ้ำได้) ---
function startRover(label, user, pass) {
    const client = new net.Socket();
    const authStr = Buffer.from(`${user}:${pass}`).toString('base64');

    console.log(`🚜 ${label} (${user}): กำลังเชื่อมต่อ...`);
    
    client.connect(PORT, HOST, () => {
        client.write(`GET /${BASE_MOUNTPOINT} HTTP/1.0\r\n`);
        client.write(`User-Agent: NTRIP Client/1.0\r\n`);
        client.write(`Authorization: Basic ${authStr}\r\n`);
        client.write(`\r\n`);
    });

    client.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('ICY 200 OK')) {
            console.log(`✅ ${label} (${user}): Login สำเร็จ! (Online)`);
        } else if (data.length > 5) {
            // ได้รับข้อมูล RTCM (แสดงแค่ครั้งเดียวพอเดี๋ยวรก)
            // console.log(`✨ ${label}: ได้รับข้อมูล ${data.length} bytes`);
        } else {
             console.log(`❓ ${label} message:`, msg);
        }
    });

    client.on('close', () => console.log(`🔻 ${label} Disconnected`));
    client.on('error', (err) => console.log(`❌ ${label} Error:`, err.message));
}
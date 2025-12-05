process.env.NTRIP_DB_PATH = ':memory:';

const net = require('net');
const request = require('supertest');

const {
    startWebServer,
    stopWebServer,
    startNtripServer,
    stopNtripServer,
    activeMountpoints,
    activeClients
} = require('../server');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const connectBase = (port, mountpoint, password) => {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port }, () => {
            const requestLines = [
                `SOURCE ${password} /${mountpoint}`,
                'Source-Agent: Jest-Test',
                '\r\n'
            ].join('\r\n');
            socket.write(requestLines);
        });

        let response = '';
        const dataListener = (chunk) => {
            response += chunk.toString();
            if (response.includes('OK')) {
                socket.off('data', dataListener);
                resolve(socket);
            }
        };

        socket.on('data', dataListener);
        socket.on('error', reject);
        socket.on('end', () => {
            if (!response.includes('OK')) {
                reject(new Error('Connection closed before handshake completed'));
            }
        });
    });
};

const buildRtcmFrame = (messageId) => {
    const byte1 = (messageId >> 4) & 0xFF;
    const byte2 = (messageId & 0x0F) << 4;
    const payload = Buffer.from([byte1, byte2, 0x00, 0x00]);
    const header = Buffer.from([0xD3, 0x00, payload.length]);
    const crc = Buffer.from([0x00, 0x00, 0x00]);
    return Buffer.concat([header, payload, crc]);
};

let webServer;

beforeAll(async () => {
    webServer = startWebServer(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        webServer.once('listening', resolve);
        webServer.once('error', reject);
    });
});

afterAll(async () => {
    await stopWebServer();
});

const httpRequest = () => request(webServer);

describe('REST API', () => {
    test('status endpoint reports zero active connections when idle', async () => {
        const res = await httpRequest().get('/api/status');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.connections)).toBe(true);
        expect(res.body.totalBases).toBe(0);
        expect(res.body.totalRovers).toBe(0);
    });

    test('mountpoints and users can be created via API', async () => {
        const mountName = `MP${Date.now()}`;
        const userName = `user${Date.now()}`;

        const mpRes = await httpRequest()
            .post('/api/mountpoints')
            .send({ name: mountName, password: 'secret' })
            .set('Content-Type', 'application/json');
        expect(mpRes.status).toBe(200);
        expect(mpRes.body).toHaveProperty('message', 'Success');

        const mpList = await httpRequest().get('/api/mountpoints');
        const mpNames = mpList.body.map(r => r.name);
        expect(mpNames).toContain(mountName);

        const userRes = await httpRequest()
            .post('/api/users')
            .send({ username: userName, password: 'pass1234' })
            .set('Content-Type', 'application/json');
        expect(userRes.status).toBe(200);
        expect(userRes.body).toHaveProperty('message', 'Success');

        const userList = await httpRequest().get('/api/users');
        const usernames = userList.body.map(r => r.username);
        expect(usernames).toContain(userName);
    });
});

describe('NTRIP TCP server', () => {
    let ntripInstance;
    let ntripPort;

    beforeAll(async () => {
        ntripInstance = startNtripServer(0);
        await new Promise((resolve, reject) => {
            ntripInstance.once('listening', resolve);
            ntripInstance.once('error', reject);
        });
        ntripPort = ntripInstance.address().port;
    });

    afterAll(async () => {
        await stopNtripServer();
    });

    test('responds with sourcetable when no mountpoint specified', async () => {
        const payload = await new Promise((resolve, reject) => {
            const client = net.createConnection({ port: ntripPort }, () => {
                client.write('GET / HTTP/1.0\r\n\r\n');
            });
            let response = '';
            client.on('data', chunk => response += chunk.toString());
            client.on('end', () => resolve(response));
            client.on('error', reject);
        });
        expect(payload).toContain('SOURCETABLE 200 OK');
        expect(payload).toContain('ENDSOURCETABLE');
    });

    test('accepts SOURCE login and reports RTCM message categories', async () => {
        const mountName = `LIVE${Date.now()}`;
        await httpRequest()
            .post('/api/mountpoints')
            .send({ name: mountName, password: 'casterpass' })
            .set('Content-Type', 'application/json');

        const socket = await connectBase(ntripPort, mountName, 'casterpass');
        const rtcmFrame = buildRtcmFrame(1074);
        socket.write(rtcmFrame);
        await wait(100);

        const statusRes = await httpRequest().get('/api/status');
        const mountEntry = statusRes.body.connections.find(c => c.mountpoint === mountName);
        expect(mountEntry).toBeDefined();
        expect(mountEntry.baseMessages.some(msg => msg.includes('Multi-Service Messages'))).toBe(true);
        expect(mountEntry.baseIp).toBeTruthy();

        socket.end();
        await wait(50);
        expect(activeMountpoints.has(mountName)).toBe(false);
        expect([...activeClients.values()].some(c => c.mountpoint === mountName)).toBe(false);
    });
});

// --- 1. MAP SETUP (ตั้งค่าแผนที่) ---
const map = L.map('map').setView([13.7563, 100.5018], 6); // พิกัดกลางประเทศไทย
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);
const baseLayer = L.layerGroup().addTo(map);
const roverLayer = L.layerGroup().addTo(map);
let mapFittedOnce = false;

function formatDuration(totalSeconds) {
    if (typeof totalSeconds !== 'number' || Number.isNaN(totalSeconds)) return '-';
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}

function formatPosition(position) {
    if (!position || typeof position.lat !== 'number' || typeof position.lon !== 'number') {
        return '<span class="has-text-grey-light is-size-7">Unknown</span>';
    }
    return `${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`;
}

function renderBaseMessages(messages) {
    if (!messages || messages.length === 0) {
        return '<span class="tag is-light is-size-7">No RTCM yet</span>';
    }
    return messages.map(msg => `<span class="tag is-info is-light is-size-7">${msg}</span>`).join('<br>');
}

function renderMap(mapData) {
    if (!mapData) return;
    baseLayer.clearLayers();
    roverLayer.clearLayers();
    const bounds = [];

    (mapData.bases || []).forEach(base => {
        if (typeof base.lat !== 'number' || typeof base.lon !== 'number') return;
        const marker = L.circleMarker([base.lat, base.lon], {
            radius: 6,
            weight: 2,
            color: '#3273dc',
            fillColor: '#b3c9ff',
            fillOpacity: 0.9
        }).bindPopup(`<strong>${base.name}</strong><br>Base Station`);
        marker.addTo(baseLayer);
        bounds.push([base.lat, base.lon]);
    });

    (mapData.rovers || []).forEach(rover => {
        if (typeof rover.lat !== 'number' || typeof rover.lon !== 'number') return;
        const marker = L.marker([rover.lat, rover.lon]).bindPopup(`<strong>${rover.name}</strong><br>via ${rover.mountpoint || '-'}`);
        marker.addTo(roverLayer);
        bounds.push([rover.lat, rover.lon]);
    });

    if (bounds.length === 0) {
        mapFittedOnce = false;
    } else if (!mapFittedOnce) {
        map.fitBounds(bounds, { padding: [20, 20] });
        mapFittedOnce = true;
    }
}

// --- 2. DASHBOARD LOGIC (ทำงานอัตโนมัติ) ---
function updateDashboard() {
    // เช็คว่าเปิดหน้า Dashboard อยู่ไหม (ถ้าปิดอยู่ไม่ต้องโหลด เพื่อประหยัดเน็ต)
    const dashboardTab = document.getElementById('content-dashboard');
    if (!dashboardTab || dashboardTab.style.display === 'none') return;

    fetch('/api/status')
        .then(res => res.json())
        .then(data => {
            // อัปเดตตัวเลขสรุป
            document.getElementById('base-count').innerText = data.totalBases;
            document.getElementById('rover-count').innerText = data.totalRovers;

            const tbody = document.getElementById('mp-table');
            tbody.innerHTML = '';
            
            // แสดงรายการในตาราง
            if (data.connections.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="has-text-centered has-text-grey is-size-7 p-4">... รอการเชื่อมต่อ ...</td></tr>';
            } else {
                data.connections.forEach(conn => {
                    const roverName = conn.rover ? `👤 <strong>${conn.rover}</strong>` : '<span class="has-text-grey-light is-size-7">Waiting...</span>';
                    const roverIp = conn.roverIp || '-';
                    const roverData = typeof conn.roverDataRate === 'number' ? conn.roverDataRate.toFixed(2) : '0.00';
                    const baseIp = conn.baseIp || '-';
                    const baseUptime = formatDuration(conn.baseUptime);
                    const roverPos = formatPosition(conn.roverPosition);
                    const baseMessages = renderBaseMessages(conn.baseMessages);

                    tbody.innerHTML += `
                        <tr>
                            <td><span class="tag is-success is-light">🟢 ${conn.mountpoint}</span></td>
                            <td><div class="base-message-tags">${baseMessages}</div></td>
                            <td>${baseIp}</td>
                            <td>${baseUptime}</td>
                            <td>${roverName}</td>
                            <td>${roverIp}</td>
                            <td>${roverPos}</td>
                            <td>${roverData}</td>
                        </tr>
                    `;
                });
            }

            renderMap(data.map);
        })
        .catch(err => console.error("API Error:", err));
}

// สั่งให้อัปเดตทุก 2 วินาที
setInterval(updateDashboard, 2000);


// --- 3. TAB LOGIC (สลับหน้าจอ) ---
function switchTab(tabName) {
    // ซ่อนเนื้อหาทั้งหมดก่อน
    document.getElementById('content-dashboard').style.display = 'none';
    document.getElementById('content-settings').style.display = 'none';
    
    // เอาขีดเส้นใต้ Active ออกจากเมนู
    document.getElementById('tab-dashboard').classList.remove('is-active');
    document.getElementById('tab-settings').classList.remove('is-active');

    // แสดงหน้าที่เลือก
    document.getElementById('content-' + tabName).style.display = 'block';
    document.getElementById('tab-' + tabName).classList.add('is-active');

    // โหลดข้อมูลตามหน้าที่เข้า
    if (tabName === 'settings') {
        loadMountpoints();
        loadUsers();
    } else {
        updateDashboard();
        // แก้บั๊กแผนที่ Leaflet (โหลดแมพใหม่เมื่อกลับมาหน้านี้)
        setTimeout(() => map.invalidateSize(), 100); 
    }
}


// --- 4. MANAGEMENT LOGIC (จัดการ Database) ---

// === Base Station (Mountpoints) ===
function loadMountpoints() {
    fetch('/api/mountpoints')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('list-mountpoints');
            tbody.innerHTML = '';
            if (rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="2" class="has-text-centered has-text-grey">ไม่มีข้อมูล</td></tr>';
                return;
            }
            rows.forEach(row => {
                tbody.innerHTML += `
                    <tr>
                        <td><strong>${row.name}</strong></td>
                        <td>
                            <button class="button is-small is-danger is-light" onclick="delMountpoint('${row.name}')">Delete</button>
                        </td>
                    </tr>`;
            });
        });
}

function addMountpoint() {
    const name = document.getElementById('new-mp-name').value.trim();
    const pass = document.getElementById('new-mp-pass').value.trim();
    if(!name || !pass) return alert("กรุณากรอกข้อมูลให้ครบ");

    fetch('/api/mountpoints', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name: name, password: pass })
    }).then(res => res.json()).then(data => {
        if(data.error) alert(data.error);
        else {
            document.getElementById('new-mp-name').value = '';
            document.getElementById('new-mp-pass').value = '';
            loadMountpoints();
        }
    });
}

function delMountpoint(name) {
    if(!confirm(`ต้องการลบ Base Station: ${name} ใช่หรือไม่?`)) return;
    fetch('/api/mountpoints/' + name, { method: 'DELETE' }).then(() => loadMountpoints());
}

// === Rover (Users) ===
function loadUsers() {
    fetch('/api/users')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('list-users');
            tbody.innerHTML = '';
            if (rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="2" class="has-text-centered has-text-grey">ไม่มีข้อมูล</td></tr>';
                return;
            }
            rows.forEach(row => {
                tbody.innerHTML += `
                    <tr>
                        <td>👤 ${row.username}</td>
                        <td>
                            <button class="button is-small is-danger is-light" onclick="delUser('${row.username}')">Delete</button>
                        </td>
                    </tr>`;
            });
        });
}

function addUser() {
    const user = document.getElementById('new-user-name').value.trim();
    const pass = document.getElementById('new-user-pass').value.trim();
    if(!user || !pass) return alert("กรุณากรอกข้อมูลให้ครบ");

    fetch('/api/users', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: user, password: pass })
    }).then(res => res.json()).then(data => {
        if(data.error) alert(data.error);
        else {
            document.getElementById('new-user-name').value = '';
            document.getElementById('new-user-pass').value = '';
            loadUsers();
        }
    });
}

function delUser(username) {
    if(!confirm(`ต้องการลบ User: ${username} ใช่หรือไม่?`)) return;
    fetch('/api/users/' + username, { method: 'DELETE' }).then(() => loadUsers());
}

// เริ่มต้นทำงานทันทีเมื่อโหลดเสร็จ
updateDashboard();

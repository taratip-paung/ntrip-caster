// --- 1. MAP SETUP (ตั้งค่าแผนที่) ---
const map = L.map('map').setView([13.7563, 100.5018], 6); // พิกัดกลางประเทศไทย
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

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
                tbody.innerHTML = '<tr><td colspan="3" class="has-text-centered has-text-grey is-size-7 p-4">... รอการเชื่อมต่อ ...</td></tr>';
            } else {
                data.connections.forEach(conn => {
                    const kb = (conn.bytesIn / 1024).toFixed(1);
                    
                    // ตกแต่ง: ถ้าไม่มี Rover ให้แสดงเป็นตัวหนังสือสีจางๆ
                    let roverDisplay = '';
                    if (conn.rover === '-') {
                        roverDisplay = '<span class="has-text-grey-light is-size-7">Waiting...</span>';
                    } else {
                        roverDisplay = `👤 <strong>${conn.rover}</strong>`;
                    }

                    // สร้างแถวตาราง
                    tbody.innerHTML += `
                        <tr>
                            <td><span class="tag is-success is-light">🟢 ${conn.mountpoint}</span></td>
                            <td>${roverDisplay}</td>
                            <td>${kb} KB</td>
                        </tr>
                    `;
                });
            }
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
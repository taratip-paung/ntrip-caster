// --- MAP SETUP ---
const map = L.map('map').setView([13.7563, 100.5018], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// --- DASHBOARD LOGIC (Live Status) ---
function updateDashboard() {
    // ถ้าไม่อยู่หน้า Dashboard ไม่ต้องโหลด (ประหยัด Resource)
    const dashboardTab = document.getElementById('content-dashboard');
    if (!dashboardTab || dashboardTab.style.display === 'none') return;

    fetch('/api/status')
        .then(res => res.json())
        .then(data => {
            document.getElementById('base-count').innerText = data.mountpoints.length;
            document.getElementById('rover-count').innerText = data.totalRovers;

            const tbody = document.getElementById('mp-table');
            tbody.innerHTML = '';
            
            if (data.mountpoints.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="has-text-centered has-text-grey is-size-7">Waiting for connections...</td></tr>';
            } else {
                data.mountpoints.forEach(mp => {
                    const kb = (mp.bytesIn / 1024).toFixed(1);
                    tbody.innerHTML += `
                        <tr>
                            <td><span class="tag is-success is-light">🟢 ${mp.name}</span></td>
                            <td>${mp.clients} 👤</td>
                            <td>${kb} KB</td>
                        </tr>
                    `;
                });
            }
        })
        .catch(err => console.error(err));
}

// อัปเดตสถานะทุก 2 วินาที
setInterval(updateDashboard, 2000);


// --- TAB SWITCHING LOGIC ---
function switchTab(tabName) {
    // 1. ซ่อนเนื้อหาทั้งหมดก่อน
    document.getElementById('content-dashboard').style.display = 'none';
    document.getElementById('content-settings').style.display = 'none';
    
    // 2. เอา Active class ออกจากปุ่ม
    document.getElementById('tab-dashboard').classList.remove('is-active');
    document.getElementById('tab-settings').classList.remove('is-active');

    // 3. แสดงเฉพาะหน้าที่เลือก
    document.getElementById('content-' + tabName).style.display = 'block';
    document.getElementById('tab-' + tabName).classList.add('is-active');

    // 4. โหลดข้อมูลตามหน้า
    if (tabName === 'settings') {
        // ถ้าเข้าหน้า Settings ให้ดึงข้อมูลจาก Database มาโชว์ทันที
        loadMountpoints();
        loadUsers();
    } else {
        // ถ้ากลับมาหน้า Dashboard ให้โหลดสถานะล่าสุด และแก้บั๊กแผนที่
        updateDashboard();
        setTimeout(() => map.invalidateSize(), 100); 
    }
}


// --- MANAGEMENT LOGIC (CRUD) ---

// 1. โหลดรายชื่อ Base Station
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
                            <button class="button is-small is-danger is-light" onclick="delMountpoint('${row.name}')">
                                Delete
                            </button>
                        </td>
                    </tr>`;
            });
        });
}

// 2. เพิ่ม Base Station
function addMountpoint() {
    const name = document.getElementById('new-mp-name').value;
    const pass = document.getElementById('new-mp-pass').value;
    if(!name || !pass) return alert("กรุณากรอกข้อมูลให้ครบ");

    fetch('/api/mountpoints', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name: name, password: pass })
    }).then(res => res.json()).then(data => {
        if(data.error) {
            alert("เกิดข้อผิดพลาด: " + data.error);
        } else {
            // เคลียร์ช่องกรอก และโหลดรายการใหม่
            document.getElementById('new-mp-name').value = '';
            document.getElementById('new-mp-pass').value = '';
            loadMountpoints(); 
        }
    });
}

// 3. ลบ Base Station
function delMountpoint(name) {
    if(!confirm(`ยืนยันการลบ Base Station: ${name}?`)) return;
    fetch('/api/mountpoints/' + name, { method: 'DELETE' })
        .then(() => loadMountpoints());
}

// 4. โหลดรายชื่อ Rover Users
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
                            <button class="button is-small is-danger is-light" onclick="delUser('${row.username}')">
                                Delete
                            </button>
                        </td>
                    </tr>`;
            });
        });
}

// 5. เพิ่ม Rover User
function addUser() {
    const user = document.getElementById('new-user-name').value;
    const pass = document.getElementById('new-user-pass').value;
    if(!user || !pass) return alert("กรุณากรอกข้อมูลให้ครบ");

    fetch('/api/users', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: user, password: pass })
    }).then(res => res.json()).then(data => {
        if(data.error) {
            alert("เกิดข้อผิดพลาด: " + data.error);
        } else {
            // เคลียร์ช่องกรอก และโหลดรายการใหม่
            document.getElementById('new-user-name').value = '';
            document.getElementById('new-user-pass').value = '';
            loadUsers();
        }
    });
}

// 6. ลบ Rover User
function delUser(username) {
    if(!confirm(`ยืนยันการลบ User: ${username}?`)) return;
    fetch('/api/users/' + username, { method: 'DELETE' })
        .then(() => loadUsers());
}

// เริ่มต้นทำงาน (โหลดหน้า Dashboard)
updateDashboard();
// --- MAP SETUP (Leaflet) ---
const map = L.map('map').setView([13.7563, 100.5018], 6); // พิกัดกลางประเทศไทย
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// --- DASHBOARD LOGIC ---
function updateDashboard() {
    // ถ้าไม่ได้เปิดหน้า Dashboard อยู่ ให้ข้ามไป (ประหยัดทรัพยากร)
    const dashboardTab = document.getElementById('content-dashboard');
    if (!dashboardTab || dashboardTab.style.display === 'none') return;

    fetch('/api/status')
        .then(res => res.json())
        .then(data => {
            // อัปเดตตัวเลขสรุป
            document.getElementById('base-count').innerText = data.mountpoints.length;
            document.getElementById('rover-count').innerText = data.totalRovers;

            // อัปเดตตารางสถานะ
            const tbody = document.getElementById('mp-table');
            tbody.innerHTML = '';
            
            if (data.mountpoints.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="has-text-centered is-size-7 has-text-grey">Waiting for connection...</td></tr>';
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
        .catch(err => console.error("API Error:", err));
}

// ตั้งเวลาให้อัปเดต Dashboard ทุก 2 วินาที
setInterval(updateDashboard, 2000);

// --- TAB SWITCHING LOGIC ---
function switchTab(tabName) {
    // ซ่อนทุก Tab
    document.getElementById('content-dashboard').style.display = 'none';
    document.getElementById('content-settings').style.display = 'none';
    
    // เอา active ออกจากปุ่ม
    document.getElementById('tab-dashboard').classList.remove('is-active');
    document.getElementById('tab-settings').classList.remove('is-active');

    // แสดง Tab ที่เลือก
    document.getElementById('content-' + tabName).style.display = 'block';
    document.getElementById('tab-' + tabName).classList.add('is-active');

    // ถ้าเข้าหน้า Settings ให้โหลดข้อมูลใหม่ทันที
    if (tabName === 'settings') {
        loadMountpoints();
        loadUsers();
    } else {
        // ถ้ากลับมาหน้า Dashboard ให้โหลดข้อมูลและแก้บั๊กแผนที่
        updateDashboard();
        setTimeout(() => map.invalidateSize(), 100); 
    }
}

// --- SETTINGS: Base Station (Mountpoint) Functions ---
function loadMountpoints() {
    fetch('/api/mountpoints')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('list-mountpoints');
            tbody.innerHTML = '';
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

function addMountpoint() {
    const name = document.getElementById('new-mp-name').value;
    const pass = document.getElementById('new-mp-pass').value;
    if(!name || !pass) return alert("Please fill in both Name and Password");

    fetch('/api/mountpoints', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name: name, password: pass })
    }).then(res => res.json()).then(data => {
        if(data.error) {
            alert("Error: " + data.error);
        } else {
            document.getElementById('new-mp-name').value = '';
            document.getElementById('new-mp-pass').value = '';
            loadMountpoints(); // Refresh list
        }
    });
}

function delMountpoint(name) {
    if(!confirm(`Are you sure you want to delete Base Station: ${name}?`)) return;
    fetch('/api/mountpoints/' + name, { method: 'DELETE' })
        .then(() => loadMountpoints());
}

// --- SETTINGS: Rover (User) Functions ---
function loadUsers() {
    fetch('/api/users')
        .then(r => r.json())
        .then(rows => {
            const tbody = document.getElementById('list-users');
            tbody.innerHTML = '';
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

function addUser() {
    const user = document.getElementById('new-user-name').value;
    const pass = document.getElementById('new-user-pass').value;
    if(!user || !pass) return alert("Please fill in both Username and Password");

    fetch('/api/users', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: user, password: pass })
    }).then(res => res.json()).then(data => {
        if(data.error) {
            alert("Error: " + data.error);
        } else {
            document.getElementById('new-user-name').value = '';
            document.getElementById('new-user-pass').value = '';
            loadUsers(); // Refresh list
        }
    });
}

function delUser(username) {
    if(!confirm(`Are you sure you want to delete User: ${username}?`)) return;
    fetch('/api/users/' + username, { method: 'DELETE' })
        .then(() => loadUsers());
}

// Start Dashboard update immediately
updateDashboard();
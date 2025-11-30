// ตั้งพิกัดเริ่มต้น (กรุงเทพฯ หรือที่ไหนก็ได้)
const map = L.map('map').setView([13.7563, 100.5018], 6); 

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
}).addTo(map);

function updateDashboard() {
    fetch('/api/status')
        .then(res => res.json())
        .then(data => {
            // อัปเดตตัวเลข
            document.getElementById('base-count').innerText = data.mountpoints.length;
            document.getElementById('rover-count').innerText = data.totalRovers;

            // อัปเดตตาราง
            const tbody = document.getElementById('mp-table');
            tbody.innerHTML = '';
            
            if (data.mountpoints.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="has-text-centered has-text-grey">No Base Station Online</td></tr>';
            } else {
                data.mountpoints.forEach(mp => {
                    const kb = (mp.bytesIn / 1024).toFixed(1);
                    tbody.innerHTML += `
                        <tr>
                            <td><span class="tag is-success is-light">🟢 ${mp.name}</span></td>
                            <td>${mp.clients}</td>
                            <td>${kb} KB</td>
                        </tr>
                    `;
                });
            }
        })
        .catch(err => console.error(err));
}

// อัปเดตทุก 2 วินาที
setInterval(updateDashboard, 2000);
updateDashboard();
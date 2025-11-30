# ใช้ Node.js ตัวเล็ก (Alpine)
FROM node:18-alpine

# ตั้งค่า Timezone เป็นไทย (จะได้ไม่งงเวลาดู Log)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Bangkok

# สร้างโฟลเดอร์ใน Container
WORKDIR /app

# ก๊อปปี้ไฟล์ package.json ไปก่อนเพื่อลง library
COPY package.json ./
RUN npm install

# ก๊อปปี้ไฟล์โค้ดทั้งหมดตามไปทีหลัง
COPY . .

# เปิด Port 2101 (NTRIP) และ 3000 (Web)
EXPOSE 2101 3000

# คำสั่งรัน
CMD ["npm", "start"]
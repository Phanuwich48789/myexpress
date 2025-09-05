// index.js (ฉบับอัปเกรด Gemini และแก้ไขการเว้นบรรทัด)
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// --- การตั้งค่าทั้งหมด ---

// Supabase
/* const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
); */

const supabase = createClient(
  process.env.SUPABASE_URL,
  // process.env.SUPABASE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


// LINE
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || ""
};
const client = new line.Client(config);

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Middleware และ Routes ---
app.use('/webhook', line.middleware(config));

app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleImageMessage(event) {
  const messageId = event.message.id;

  try {
    // ดึงไฟล์ภาพจาก LINE
    const stream = await client.getMessageContent(messageId);

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // อัปโหลดรูปเข้า Supabase Storage
    const fileName = `line_images/${messageId}.jpg`;
    const { data, error } = await supabase.storage
      .from("uploads")
      .upload(fileName, buffer, {
        contentType: "image/jpeg",
        upsert: true,
      });

    if (error) {
      console.error("❌ Upload error:", error);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "อัปโหลดรูปไป Supabase ไม่สำเร็จ",
      });
    }

    console.log("✅ Uploaded to Supabase:", data);

    // 🔗 สร้าง Public URL ของรูป
    const {
      data: { publicUrl },
    } = supabase.storage.from("uploads").getPublicUrl(fileName);

    console.log("🌐 Public URL:", publicUrl);

    // ส่งภาพให้ Gemini วิเคราะห์ว่าเป็นสัตว์อะไร
    const imageParts = [
      {
        inlineData: {
          data: buffer.toString("base64"),
          mimeType: "image/jpeg",
        },
      },
    ];

    const prompt = `ภาพนี้คือสัตว์อะไร? ช่วยบอกชื่อของสัตว์นี้เป็นภาษาไทยให้ชัดเจน`;

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...imageParts,
          ],
        },
      ],
    });

    const response = await result.response;
    const animalName = response.text().trim();

    console.log("🐾 ผลจาก Gemini:", animalName);

    // ตอบกลับชื่อสัตว์
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `สัตว์ในภาพคือ: ${animalName}`,
    });

  } catch (err) {
    console.error("❌ Error handling image:", err);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขออภัย, ไม่สามารถวิเคราะห์ภาพได้ในขณะนี้",
    });
  }
}


async function handleEvent(event) {
    if (event.type === "message" && event.message.type === "image") {
    return handleImageMessage(event);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;

  try {
    const prompt = `คุณคือ AI ผู้ช่วยที่เป็นมิตรและมีไหวพริบ จงตอบกลับข้อความนี้ตรงๆ: "${userMessage}"`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;

    // --- จุดที่แก้ไข: เพิ่ม .trim() เพื่อตัดบรรทัดและช่องว่างที่ไม่จำเป็นออก ---
    const geminiReply = response.text().trim(); 

    const { error } = await supabase
      .from("messages")
      .insert({
        user_id: event.source.userId,
        message_id: event.message.id,
        type: event.message.type,
        content: userMessage,
        reply_token: event.replyToken,
        reply_content: geminiReply,
      });

    if (error) {
      console.error("Error inserting message to Supabase:", error);
    }

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: geminiReply,
    });

  } catch (err) {
    console.error("Error communicating with Gemini or LINE:", err);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ขออภัย, ตอนนี้ AI กำลังประมวลผลผิดพลาดเล็กน้อย ลองอีกครั้งนะ',
    });
  }
}

app.get('/', (req, res) => {
  res.send('hello world, Phanuwich');
});

const PORT = process.env.PORT || 3009;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
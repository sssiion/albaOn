const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// 라우터 연결
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/stores',  require('./routes/stores'));
app.use('/api/manuals', require('./routes/manuals'));
app.use('/api/chat',    require('./routes/chat'));
app.use('/api/invite',  require('./routes/invite'));
app.use('/api/categories', require('./routes/categories'));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`));

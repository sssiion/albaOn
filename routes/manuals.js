const multer = require('multer');
const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 업로드 폴더 생성
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// multer 설정
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp4', 'audio/wav',
                     'audio/webm', 'audio/ogg', 'audio/m4a',
                     'video/mp4', 'application/octet-stream'];
    if (allowed.includes(file.mimetype) ||
        file.originalname.match(/\.(mp3|mp4|wav|webm|ogg|m4a)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('지원하지 않는 파일 형식이에요'));
    }
  }
});

// 청크 분할
function splitIntoChunks(text, size = 500) {
  const chunks = [];
  const sentences = text.split(/(?<=[.!?。\n])\s*/);
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > size && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence + ' ';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 10);
}

// ── 매뉴얼 목록 조회 (원본만) ──────────────────
router.get('/:storeId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('manuals')
    .select('id, title, content, original_content, created_at')
    .eq('store_id', req.params.storeId)
    .eq('is_chunk', false)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── 매뉴얼 저장 ────────────────────────────────
router.post('/:storeId', auth, async (req, res) => {
  const { content } = req.body;
  const { storeId } = req.params;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    // 1. GPT로 정리
    const organized = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `편의점/카페/식당 업무 매뉴얼 작성 전문가예요.
아래 텍스트를 카테고리별로 정리해주세요.

출력 형식 (JSON):
{
  "title": "전체 내용을 대표하는 짧은 제목",
  "content": "## 카테고리1\\n- 내용\\n\\n## 카테고리2\\n- 내용"
}

JSON만 출력하고 다른 텍스트는 절대 쓰지 마세요.`
        },
        { role: 'user', content }
      ],
      max_tokens: 1000,
      temperature: 0.2
    });

    let title = '매뉴얼';
    let organizedContent = content;

    try {
      const parsed = JSON.parse(organized.choices[0].message.content);
      title = parsed.title || '매뉴얼';
      organizedContent = parsed.content || content;
    } catch {
      organizedContent = content;
    }

    // 2. 원본 저장 (is_chunk: false)
    await supabase.from('manuals').insert({
      store_id:         storeId,
      title,
      content:          organizedContent,
      original_content: content,
      is_chunk:         false
    });

    // 3. 청크 + 임베딩 저장 (is_chunk: true)
    const chunks = splitIntoChunks(organizedContent);
    for (const chunk of chunks) {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk
      });
      await supabase.from('manuals').insert({
        store_id:  storeId,
        title,
        content:   chunk,
        is_chunk:  true,
        embedding: embRes.data[0].embedding
      });
    }

    res.json({ ok: true, title, organizedContent });

  } catch (err) {
    console.error('[manual error]', err.message);
    res.status(500).json({ error: '매뉴얼 저장 실패' });
  }
});

// ── 매뉴얼 수정 ────────────────────────────────
router.put('/:storeId/:manualId', auth, async (req, res) => {
  const { content } = req.body;
  const { storeId, manualId } = req.params;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    // 수정할 매뉴얼 제목 조회
    const { data: original } = await supabase
      .from('manuals')
      .select('title')
      .eq('id', manualId)
      .single();

    // 원본 업데이트
    await supabase
      .from('manuals')
      .update({ content, original_content: content })
      .eq('id', manualId)
      .eq('store_id', storeId);

    // 기존 청크 삭제
    await supabase
      .from('manuals')
      .delete()
      .eq('store_id', storeId)
      .eq('title', original.title)
      .eq('is_chunk', true);

    // 새 청크 + 임베딩 생성
    const chunks = splitIntoChunks(content);
    for (const chunk of chunks) {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk
      });
      await supabase.from('manuals').insert({
        store_id:  storeId,
        title:     original.title,
        content:   chunk,
        is_chunk:  true,
        embedding: embRes.data[0].embedding
      });
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[manual update error]', err.message);
    res.status(500).json({ error: '수정 실패' });
  }
});

// ── 매뉴얼 삭제 ────────────────────────────────
router.delete('/:storeId/:manualId', auth, async (req, res) => {
  const { storeId, manualId } = req.params;

  try {
    // 제목 조회
    const { data: original } = await supabase
      .from('manuals')
      .select('title')
      .eq('id', manualId)
      .single();

    // 원본 삭제
    await supabase
      .from('manuals')
      .delete()
      .eq('id', manualId)
      .eq('store_id', storeId);

    // 관련 청크도 삭제
    await supabase
      .from('manuals')
      .delete()
      .eq('store_id', storeId)
      .eq('title', original.title)
      .eq('is_chunk', true);

    res.json({ ok: true });

  } catch (err) {
    console.error('[manual delete error]', err.message);
    res.status(500).json({ error: '삭제 실패' });
  }
});

// ── 녹음 업로드 → 매뉴얼 자동 변환 ──────────────
router.post('/:storeId/upload', auth, upload.single('audio'), async (req, res) => {
  const { storeId } = req.params;
  const file = req.file;

  if (!file) return res.status(400).json({ error: '파일 필수' });

  try {
    const audioStream = fs.createReadStream(file.path);
    const transcription = await openai.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-1',
      language: 'ko'
    });
    const rawText = transcription.text;
    fs.unlinkSync(file.path);

    res.json({ rawText, ok: true });

  } catch (err) {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error('[whisper error]', err.message);
    res.status(500).json({ error: 'STT 변환 실패: ' + err.message });
  }
});

module.exports = router;

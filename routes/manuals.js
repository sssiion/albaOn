const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 업로드 폴더 생성
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// multer 설정
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB 제한
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

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 텍스트를 청크로 분할 (500자 기준)
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

// 매뉴얼 목록 조회
router.get('/:storeId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('manuals')
    .select('id, title, content, created_at')
    .eq('store_id', req.params.storeId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 매뉴얼 저장 + 임베딩 생성
router.post('/:storeId', auth, async (req, res) => {
  const { title, content } = req.body;
  const { storeId } = req.params;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    // 청크 분할
    const chunks = splitIntoChunks(content);
    const saved = [];

    for (const chunk of chunks) {
      // 임베딩 생성
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk
      });
      const embedding = embRes.data[0].embedding;

      // DB 저장
      const { data, error } = await supabase
        .from('manuals')
        .insert({ store_id: storeId, title, content: chunk, embedding })
        .select()
        .single();

      if (error) throw error;
      saved.push(data);
    }

    res.json({ ok: true, count: saved.length, chunks: saved });

  } catch (err) {
    console.error('[manual embed error]', err.message);
    res.status(500).json({ error: '임베딩 생성 실패' });
  }
});

// 매뉴얼 삭제
router.delete('/:storeId/:manualId', auth, async (req, res) => {
  const { error } = await supabase
    .from('manuals')
    .delete()
    .eq('id', req.params.manualId)
    .eq('store_id', req.params.storeId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
// 녹음 파일 → 텍스트 변환 → 매뉴얼 자동 정리
router.post('/:storeId/upload', auth, upload.single('audio'), async (req, res) => {
  const { storeId } = req.params;
  const file = req.file;

  if (!file) return res.status(400).json({ error: '파일 필수' });

  try {
    // 1. Whisper STT — 음성 → 텍스트
    const audioStream = fs.createReadStream(file.path);
    const transcription = await openai.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-1',
      language: 'ko'
    });
    const rawText = transcription.text;

    // 2. GPT-4o-mini — 텍스트 → 카테고리별 매뉴얼 정리
    const organized = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 편의점/카페/식당 업무 매뉴얼 작성 전문가예요.
아래 텍스트는 점주가 알바생한테 업무를 설명하는 대화나 메모예요.
이걸 카테고리별로 깔끔하게 정리해주세요.

형식:
## [카테고리명]
- 내용1
- 내용2

카테고리 예시: POS 사용법, 담배 관리, 폐기 절차, 오픈/마감, 주의사항, 비상연락망 등
중복 내용은 합치고, 불필요한 잡담은 제거해주세요.
반드시 한국어로, 간결하고 명확하게 작성하세요.`
        },
        { role: 'user', content: rawText }
      ],
      max_tokens: 2000,
      temperature: 0.2
    });

    const organizedText = organized.choices[0].message.content;

    // 3. 임시 파일 삭제
    fs.unlinkSync(file.path);

    // 4. 원본 텍스트 + 정리된 텍스트 반환 (저장은 클라이언트에서 확인 후)
    res.json({
      rawText,
      organizedText,
      ok: true
    });

  } catch (err) {
    // 에러 시 임시 파일 정리
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error('[whisper error]', err.message);
    res.status(500).json({ error: 'STT 변환 실패: ' + err.message });
  }
});
router.post('/:storeId', auth, async (req, res) => {
  const { content } = req.body;
  const { storeId } = req.params;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    // 1. GPT로 제목 + 내용 자동 정리
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

    // 2. JSON 파싱
    let title = '매뉴얼';
    let organizedContent = content;

    try {
      const parsed = JSON.parse(organized.choices[0].message.content);
      title = parsed.title || '매뉴얼';
      organizedContent = parsed.content || content;
    } catch {
      // 파싱 실패하면 원본 사용
      organizedContent = content;
    }

    // 3. 청크 분할 + 임베딩 저장
    const chunks = splitIntoChunks(organizedContent);
    const saved = [];

    for (const chunk of chunks) {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk
      });
      const embedding = embRes.data[0].embedding;

      const { data, error } = await supabase
        .from('manuals')
        .insert({ store_id: storeId, title, content: chunk, embedding })
        .select()
        .single();

      if (error) throw error;
      saved.push(data);
    }

    res.json({
      ok: true,
      title,
      organizedContent,
      count: saved.length
    });

  } catch (err) {
    console.error('[manual error]', err.message);
    res.status(500).json({ error: '매뉴얼 저장 실패' });
  }
});

module.exports = router;
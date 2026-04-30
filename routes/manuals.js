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

// Groq 초기화 (파일 상단에 추가)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

// 미답변 질문 자동 재답변
async function reanswerPending(storeId) {
  try {
    // 미답변 질문 전체 조회
    const { data: pendingLogs } = await supabase
      .from('chat_logs')
      .select('id, question')
      .eq('store_id', storeId)
      .eq('is_answered', false);

    if (!pendingLogs || pendingLogs.length === 0) return;

    console.log(`[reanswer] 미답변 ${pendingLogs.length}개 처리 중...`);

    for (const log of pendingLogs) {
      try {
        // 임베딩 생성
        const embRes = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: log.question
        });

        // 유사 매뉴얼 검색
        const { data: chunks } = await supabase.rpc('match_manuals', {
          query_embedding: embRes.data[0].embedding,
          store_id_param:  storeId,
          match_count:     5
        });

        const context = chunks?.map(c => c.content).join('\n\n') || '';

        // 매뉴얼이 없으면 스킵
        if (!context) continue;

        // Groq 답변 생성
        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `편의점 알바생을 도와주는 AI 도우미예요.
매장 매뉴얼을 참고해서 짧고 명확하게 답변해주세요.
매뉴얼에 없는 내용은 "매뉴얼에 없는 내용이에요"라고 답하세요.

[매장 매뉴얼]
${context}`
            },
            { role: 'user', content: log.question }
          ],
          max_tokens: 400,
          temperature: 0.3
        });

        const answer = completion.choices[0].message.content;
        const isAnswered = !answer.includes('매뉴얼에 없는 내용');

        // 답변이 됐을 때만 업데이트
        if (isAnswered) {
          await supabase
            .from('chat_logs')
            .update({ answer, is_answered: true })
            .eq('id', log.id);

          console.log(`[reanswer] 질문 해결: ${log.question.slice(0, 30)}...`);
        }

      } catch (err) {
        console.error(`[reanswer] 개별 오류:`, err.message);
        continue; // 하나 실패해도 계속 진행
      }
    }

    console.log('[reanswer] 완료');

  } catch (err) {
    console.error('[reanswer] 전체 오류:', err.message);
  }
}

// ── 매뉴얼 목록 조회 (원본만) ──────────────────
router.get('/:storeId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('manuals')
    .select('id, title, content, original_content, category_id, created_at') // category_id 추가
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
    // 1. 현재 카테고리 목록 조회
    const { data: categories } = await supabase
      .from('categories')
      .select('id, name')
      .eq('store_id', storeId)
      .order('order_num', { ascending: true });

    const categoryList = categories?.map(c => c.name).join(', ') || '';

    // 2. GPT로 정리 + 카테고리 분류
    const organized = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `편의점/카페/식당 업무 매뉴얼 작성 전문가예요.
아래 텍스트를 카테고리별로 정리해주세요.

${categoryList
  ? `현재 등록된 카테고리: ${categoryList}
위 카테고리 중 가장 적합한 것을 선택해주세요.
없으면 새로운 카테고리명을 만들어주세요.`
  : `적합한 카테고리명을 만들어주세요. (예: 청소, POS 사용법, 담배 관리 등)`
}

출력 형식 (JSON):
{
  "category": "카테고리명",
  "title": "세부 항목명",
  "content": "## 중분류\\n- 내용\\n\\n### 소분류\\n- 내용"
}

JSON만 출력하고 다른 텍스트는 절대 쓰지 마세요.`
        },
        { role: 'user', content }
      ],
      max_tokens: 1000,
      temperature: 0.2
    });

    let categoryName = '기타';
    let title = '매뉴얼';
    let organizedContent = content;

    try {
      const parsed = JSON.parse(organized.choices[0].message.content);
      categoryName   = parsed.category || '기타';
      title          = parsed.title    || '매뉴얼';
      organizedContent = parsed.content || content;
    } catch {
      organizedContent = content;
    }

    // 3. 카테고리 찾거나 생성
    let categoryId = null;
    const existingCat = categories?.find(
      c => c.name.toLowerCase() === categoryName.toLowerCase()
    );

    if (existingCat) {
      categoryId = existingCat.id;
    } else {
      // 새 카테고리 생성
      const { data: newCat } = await supabase
        .from('categories')
        .insert({ store_id: storeId, name: categoryName })
        .select()
        .single();
      categoryId = newCat?.id;
    }

    // 4. 원본 저장
    await supabase.from('manuals').insert({
      store_id:         storeId,
      category_id:      categoryId,
      title,
      content:          organizedContent,
      original_content: content,
      is_chunk:         false
    });

    // 5. 청크 + 임베딩 저장
    const chunks = splitIntoChunks(organizedContent);
    for (const chunk of chunks) {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk
      });
      await supabase.from('manuals').insert({
        store_id:    storeId,
        category_id: categoryId,
        title,
        content:     chunk,
        is_chunk:    true,
        embedding:   embRes.data[0].embedding
      });
    }

    // 6. 미답변 재처리
    await reanswerPending(storeId);

    res.json({ ok: true, title, categoryName, organizedContent });

  } catch (err) {
    console.error('[manual error]', err.message);
    res.status(500).json({ error: '매뉴얼 저장 실패' });
  }
});

// 매뉴얼 카테고리 이동
router.patch('/:storeId/:manualId/category', auth, async (req, res) => {
  const { categoryId } = req.body;
  const { storeId, manualId } = req.params;

  const { error } = await supabase
    .from('manuals')
    .update({ category_id: categoryId })
    .eq('id', manualId)
    .eq('store_id', storeId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
    //수정 후 미답변 재처리
    await reanswerPending(storeId);
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

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const Groq = require('groq-sdk');
const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 🔴 수정 1: PROMPTS import 추가 (기존 코드에 없었음)
const { PROMPTS } = require('./prompts');

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

// ── 유틸 함수 ───────────────────────────────────
function parseAskResponse(raw = '') {
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const questions = parsed.questions || [];
    return { questions, enough: questions.length === 0 };
  } catch {
    return { questions: [], enough: true };
  }
}

function splitIntoItems(items = []) {
  return items
    .filter(item => item.title && item.content)
    .map(item => `${item.title}: ${item.content}`.trim())
    .filter(chunk => chunk.length > 5);
}

function parseOrganizeResponse(raw = '', fallback = '') {
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const items = parsed.items || [];
    return {
      category: parsed.category || '기타',
      title:    parsed.title    || '매뉴얼',
      items,
      chunks:   splitIntoItems(items),
    };
  } catch {
    return {
      category: '기타',
      title:    '매뉴얼',
      items:    [],
      chunks:   fallback ? [fallback] : [],
    };
  }
}

// Groq (LLM용)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

// ── 미답변 질문 자동 재답변 ──────────────────────
async function reanswerPending(storeId) {
  try {
    const { data: pendingLogs } = await supabase
      .from('chat_logs')
      .select('id, question')
      .eq('store_id', storeId)
      .eq('is_answered', false);

    if (!pendingLogs || pendingLogs.length === 0) return;

    console.log(`[reanswer] 미답변 ${pendingLogs.length}개 처리 중...`);

    for (const log of pendingLogs) {
      try {
        const embRes = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: log.question
        });

        const { data: chunks } = await supabase.rpc('match_manuals', {
          query_embedding: embRes.data[0].embedding,
          store_id_param:  storeId,
          match_count:     5
        });

        const context = chunks?.map(c => c.content).join('\n\n') || '';
        if (!context) continue;

        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: PROMPTS.CHAT_ANSWER({ context }) },
            { role: 'user',   content: log.question }
          ],
          max_tokens: 400,
          temperature: 0.3
        });

        const answer = completion.choices[0].message.content;
        const isAnswered = !answer.includes('매뉴얼에 없는 내용');

        if (isAnswered) {
          await supabase
            .from('chat_logs')
            .update({ answer, is_answered: true })
            .eq('id', log.id);
        }
      } catch (err) {
        console.error(`[reanswer] 개별 오류:`, err.message);
        continue;
      }
    }
    console.log('[reanswer] 완료');
  } catch (err) {
    console.error('[reanswer] 전체 오류:', err.message);
  }
}

// ── 매뉴얼 목록 조회 ────────────────────────────
// 🔴 수정 2: GET /:storeId 가 두 개 있었음 → 아래쪽 하나로 통합 (manual_node_media 포함)
router.get('/:storeId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('manuals')
    .select(`
      id, title, content, original_content, category_id, created_at,
      manual_node_media(id, node_label, url, caption)
    `)
    .eq('store_id', req.params.storeId)
    .eq('is_chunk', false)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /:storeId/ask — 보완 질문 생성 ─────────
// 🔴 순서 중요: /:storeId 보다 반드시 위에 있어야 함
router.post('/:storeId/ask', auth, async (req, res) => {
  const { storeId } = req.params;
  const { content, bizType = '매장' } = req.body;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PROMPTS.MANUAL_ASK({ bizType, content }) },
        { role: 'user',   content }
      ],
      max_tokens: 300,
      temperature: 0.2
    });

    const raw = completion.choices[0].message.content;
    const { questions, enough } = parseAskResponse(raw);

    res.json({ needsMore: !enough, questions });

  } catch (err) {
    console.error('[ask error]', err.message);
    res.json({ needsMore: false, questions: [] });
  }
});

// ── 매뉴얼 저장 ─────────────────────────────────
router.post('/:storeId', auth, async (req, res) => {
  // 🔴 수정 3: answers 도 받도록 추가 (보완 질문 답변)
  const { content, bizType = '매장', answers = [] } = req.body;
  const { storeId } = req.params;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    const { data: categories } = await supabase
      .from('categories')
      .select('id, name')
      .eq('store_id', storeId)
      .order('order_num', { ascending: true });

    const categoryList = categories?.map(c => c.name).join(', ') || '';

    // PROMPTS 사용 + answers 포함
    const organized = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: PROMPTS.MANUAL_ORGANIZE({ bizType, categoryList, content, answers })
        },
        { role: 'user', content }
      ],
      max_tokens: 1000,
      temperature: 0.2
    });

    const raw = organized.choices[0].message.content;
    // 🔴 수정 3 이어서: organizedContent 변수 제거, parseOrganizeResponse 로 통일
    const { category: categoryName, title, chunks } = parseOrganizeResponse(raw, content);

    // 카테고리 찾거나 생성
    let categoryId = null;
    const existingCat = categories?.find(
      c => c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (existingCat) {
      categoryId = existingCat.id;
    } else {
      const { data: newCat } = await supabase
        .from('categories')
        .insert({ store_id: storeId, name: categoryName })
        .select()
        .single();
      categoryId = newCat?.id;
    }

    // 원본 저장
    await supabase.from('manuals').insert({
      store_id:         storeId,
      category_id:      categoryId,
      title,
      content:          chunks.join('\n'),  // items 합쳐서 저장
      original_content: content,
      is_chunk:         false
    });

    // 청크 + 임베딩 저장
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

    await reanswerPending(storeId);
    res.json({ ok: true, title, categoryName });

  } catch (err) {
    console.error('[manual error]', err.message);
    res.status(500).json({ error: '매뉴얼 저장 실패' });
  }
});

// ── 매뉴얼 카테고리 이동 ────────────────────────
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

// ── 매뉴얼 수정 ─────────────────────────────────
router.put('/edit/:manualId', auth, async (req, res) => {
  const { content } = req.body;
  const { manualId } = req.params;

  try {
    const { data: original } = await supabase
      .from('manuals')
      .select('title, store_id')
      .eq('id', manualId)
      .single();

    await supabase
      .from('manuals')
      .update({ content })
      .eq('id', manualId);

    await supabase
      .from('manuals')
      .delete()
      .eq('store_id', original.store_id)
      .eq('title', original.title)
      .eq('is_chunk', true);

    // content는 텍스트이므로 직접 배열로 감싸서 splitIntoItems 처리
    const chunks = splitIntoItems([{ title: original.title, content }]);
    for (const chunk of chunks) {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk
      });
      await supabase.from('manuals').insert({
        store_id:  original.store_id,
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

// ── 매뉴얼 삭제 ─────────────────────────────────
router.delete('/:storeId/:manualId', auth, async (req, res) => {
  const { storeId, manualId } = req.params;

  try {
    const { data: original } = await supabase
      .from('manuals')
      .select('title')
      .eq('id', manualId)
      .single();

    await supabase.from('manuals').delete().eq('id', manualId);
    await supabase.from('manuals').delete()
      .eq('store_id', storeId)
      .eq('title', original.title)
      .eq('is_chunk', true);

    res.json({ ok: true });
  } catch (err) {
    console.error('[manual delete error]', err.message);
    res.status(500).json({ error: '삭제 실패' });
  }
});

// ── 녹음 업로드 → 보완 질문 생성 ────────────────
router.post('/:storeId/upload', auth, upload.single('audio'), async (req, res) => {
  const { storeId } = req.params;
  const { bizType = '매장' } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: '파일 필수' });

  const ext = file.originalname.split('.').pop().toLowerCase();
  const newPath = file.path + '.' + ext;
  fs.renameSync(file.path, newPath);

  try {
    // STT 변환
    const audioStream = fs.createReadStream(newPath);
    const transcription = await groqClient.audio.transcriptions.create({
      file:     audioStream,
      model:    'whisper-large-v3',
      language: 'ko'
    });
    const rawText = transcription.text;
    fs.unlinkSync(newPath);

    // 보완 질문 생성 (MANUAL_FROM_AUDIO 사용)
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PROMPTS.MANUAL_FROM_AUDIO({ bizType, rawText }) },
        { role: 'user',   content: rawText }
      ],
      max_tokens: 300,
      temperature: 0.2
    });

    const raw = completion.choices[0].message.content;
    const { questions, enough } = parseAskResponse(raw);

    // rawText 는 프론트에서 저장 시 content 로 재사용
    res.json({ rawText, needsMore: !enough, questions, ok: true });

  } catch (err) {
    if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
    console.error('[whisper error]', err.message);
    res.status(500).json({ error: 'STT 변환 실패: ' + err.message });
  }
});

// ── 기초 매뉴얼 저장 ────────────────────────────
router.post('/:storeId/basic', auth, async (req, res) => {
  const { content, bizType = '매장' } = req.body;
  const { storeId } = req.params;

  if (!content) return res.status(400).json({ error: '내용 필수' });

  try {
    const { data: categories } = await supabase
      .from('categories')
      .select('id, name')
      .eq('store_id', storeId);

    const categoryList = categories?.map(c => c.name).join(', ') || '';

    const CHUNK_SIZE = 2000;
    const textChunks = [];
    for (let i = 0; i < content.length; i += CHUNK_SIZE) {
      textChunks.push(content.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of textChunks) {
      const organized = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: PROMPTS.MANUAL_BASIC({ bizType, categoryList })
          },
          { role: 'user', content: chunk }
        ],
        max_tokens: 2000,
        temperature: 0.2
      });

      const raw = organized.choices[0].message.content;
      const { category: categoryName, title, chunks: itemChunks } = parseOrganizeResponse(raw, chunk);

      let categoryId = null;
      const existingCat = categories?.find(
        c => c.name.toLowerCase() === categoryName.toLowerCase()
      );
      if (existingCat) {
        categoryId = existingCat.id;
      } else {
        const { data: newCat } = await supabase
          .from('categories')
          .insert({ store_id: storeId, name: categoryName })
          .select()
          .single();
        categoryId = newCat?.id;
      }

      await supabase.from('manuals').insert({
        store_id:         storeId,
        category_id:      categoryId,
        title,
        content:          itemChunks.join('\n'),
        original_content: chunk,
        is_chunk:         false,
        manual_type:      'basic'
      });

      for (const embChunk of itemChunks) {
        const embRes = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: embChunk
        });
        await supabase.from('manuals').insert({
          store_id:    storeId,
          category_id: categoryId,
          title,
          content:     embChunk,
          is_chunk:    true,
          manual_type: 'basic',
          embedding:   embRes.data[0].embedding
        });
      }
    }

    await reanswerPending(storeId);
    res.json({ ok: true });

  } catch (err) {
    console.error('[basic manual error]', err.message);
    res.status(500).json({ error: '저장 실패: ' + err.message });
  }
});

// ── 기초 매뉴얼 목록 조회 ───────────────────────
router.get('/:storeId/basic', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('manuals')
    .select(`
      id, title, content, original_content, category_id, created_at,
      manual_media(id, type, url, caption, order_num)
    `)
    .eq('store_id', req.params.storeId)
    .eq('is_chunk', false)
    .eq('manual_type', 'basic')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
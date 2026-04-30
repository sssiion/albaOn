const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');
const OpenAI = require('openai');

// 임베딩용 (OpenAI)
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

// 채팅용 (Groq - 무료)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

// 채팅 (알바생이 질문)
router.post('/:storeId', async (req, res) => {
  const { storeId } = req.params;
 const { question, workerName } = req.body;

  if (!question) return res.status(400).json({ error: '질문 필수' });

  try {
    // 1. 질문 임베딩
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: question
    });
    const queryEmbedding = embRes.data[0].embedding;

    // 2. 유사 매뉴얼 검색
    const { data: chunks } = await supabase.rpc('match_manuals', {
      query_embedding: queryEmbedding,
      store_id_param: storeId,
      match_count: 5
    });

    const context = chunks?.map(c => c.content).join('\n\n') || '';

    // 3. GPT 답변 생성
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `당신은 편의점 알바생을 도와주는 친절한 AI 도우미예요.
아래 매장 매뉴얼을 참고해서 짧고 명확하게 답변해주세요.
매뉴얼에 없는 내용은 "매뉴얼에 없는 내용이에요. 점주님께 확인해주세요 😊"라고 답하세요.
반말 금지, 친근하고 간결하게.

[매장 매뉴얼]
${context || '등록된 매뉴얼이 없어요.'}`
        },
        { role: 'user', content: question }
      ],
      max_tokens: 400,
      temperature: 0.3
    });

    const answer = completion.choices[0].message.content;
    const isAnswered = !answer.includes('매뉴얼에 없는 내용');

    // 로그 저장 시 worker_id 대신 worker_name 저장
    await supabase.from('chat_logs').insert({
      store_id:    storeId,
      worker_name: workerName || '알바생',  // worker_id 대신
      question,
      answer,
      is_answered: isAnswered
    });

    res.json({ answer, isAnswered });

  } catch (err) {
    console.error('[chat error]', err.message);
    res.status(500).json({ error: '답변 생성 실패' });
  }
});

// 채팅 로그 조회 (점주용)
router.get('/:storeId/logs', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('chat_logs')
    .select(`
      id, question, answer, is_answered, created_at,
      users(name)
    `)
    .eq('store_id', req.params.storeId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;

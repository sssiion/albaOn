const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');

// 내 매장 목록 조회
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('stores')
    .select('*')
    .eq('owner_id', req.user.userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 매장 생성
router.post('/', auth, async (req, res) => {
  const { name, business_type } = req.body;

  if (!name) return res.status(400).json({ error: '매장명 필수' });

  const { data, error } = await supabase
    .from('stores')
    .insert({ owner_id: req.user.userId, name, business_type })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 매장 상세 조회
router.get('/:storeId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('stores')
    .select('*')
    .eq('id', req.params.storeId)
    .eq('owner_id', req.user.userId)
    .single();

  if (error) return res.status(404).json({ error: '매장 없음' });
  res.json(data);
});

// 매장 삭제
router.delete('/:storeId', auth, async (req, res) => {
  const { error } = await supabase
    .from('stores')
    .delete()
    .eq('id', req.params.storeId)
    .eq('owner_id', req.user.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 매장 통계 (대시보드용)
router.get('/:storeId/stats', auth, async (req, res) => {
  const { storeId } = req.params;

  try {
    // 전체 질문 수
    const { count: totalQuestions } = await supabase
      .from('chat_logs')
      .select('*', { count: 'exact', head: true })
      .eq('store_id', storeId);

    // 미답변 질문 수
    const { count: unanswered } = await supabase
      .from('chat_logs')
      .select('*', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .eq('is_answered', false);

    // 알바생 수
    const { count: workerCount } = await supabase
      .from('store_workers')
      .select('*', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .eq('status', 'active');

    // 오늘 질문 수
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: todayQuestions } = await supabase
      .from('chat_logs')
      .select('*', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .gte('created_at', today.toISOString());

    res.json({ totalQuestions, unanswered, workerCount, todayQuestions });

  } catch (err) {
    console.error('[stats error]', err.message);
    res.status(500).json({ error: '통계 조회 실패' });
  }
});
module.exports = router;
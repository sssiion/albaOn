const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');

// 초대코드로 매장 정보 조회 (알바생용 — 인증 불필요)
router.get('/:inviteCode', async (req, res) => {
  const { data, error } = await supabase
    .from('stores')
    .select('id, name, business_type')
    .eq('invite_code', req.params.inviteCode)
    .single();

  if (error) return res.status(404).json({ error: '유효하지 않은 초대 코드' });
  res.json(data);
});
// 이름 + PIN 검증 후 입장
router.post('/:inviteCode/verify', async (req, res) => {
  const { workerName, pin } = req.body;

  if (!workerName || !pin) {
    return res.status(400).json({ error: '이름과 PIN 필수' });
  }

  try {
    // 매장 찾기
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('id')
      .eq('invite_code', req.params.inviteCode)
      .single();

    if (storeErr) return res.status(404).json({ error: '유효하지 않은 초대 코드' });

    // PIN 검증
    const { data: worker, error: workerErr } = await supabase
      .from('store_workers')
      .select('id, worker_name')
      .eq('store_id', store.id)
      .eq('worker_name', workerName.trim())
      .eq('pin', pin)
      .single();

    if (workerErr || !worker) {
      return res.status(401).json({ error: '이름 또는 PIN이 틀렸어요' });
    }

    res.json({ ok: true, storeId: store.id, workerName: worker.worker_name });

  } catch (err) {
    console.error('[verify error]', err.message);
    res.status(500).json({ error: '검증 실패' });
  }
});
// 초대 수락 — 알바생이 매장에 합류
router.post('/:inviteCode/join',  async (req, res) => {
  // 매장 찾기
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('id')
    .eq('invite_code', req.params.inviteCode)
    .single();

  if (storeErr) return res.status(404).json({ error: '유효하지 않은 초대 코드' });

  // 알바생 역할로 업데이트
  await supabase
    .from('users')
    .update({ role: 'worker' })
    .eq('id', req.user.userId);

  // 매장-알바생 연결
  const { error } = await supabase
    .from('store_workers')
    .upsert({
      store_id: store.id,
      worker_id: req.user.userId
    }, { onConflict: 'store_id,worker_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, storeId: store.id });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { supabase } = require('../lib/supabase');

// 카테고리 목록 조회
router.get('/:storeId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('store_id', req.params.storeId)
    .order('order_num', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 카테고리 추가
router.post('/:storeId', auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '이름 필수' });

  const { data, error } = await supabase
    .from('categories')
    .insert({ store_id: req.params.storeId, name: name.trim() })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 카테고리 삭제
router.delete('/:storeId/:categoryId', auth, async (req, res) => {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', req.params.categoryId)
    .eq('store_id', req.params.storeId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;

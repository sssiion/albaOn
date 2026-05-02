const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('이미지만 가능해요'));
  }
});

// 이미지 업로드 또는 영상 URL 저장
router.post('/:manualId', auth, upload.single('file'), async (req, res) => {
  const { manualId } = req.params;
  const { caption, type, url } = req.body;

  try {
    // 영상 URL 저장
    if (type === 'video' && url) {
      const { data, error } = await supabase
        .from('manual_media')
        .insert({
          manual_id: manualId,
          type:      'video',
          url,
          caption:   caption || ''
        })
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    }

    // 이미지 파일 업로드
    const file = req.file;
    if (!file) return res.status(400).json({ error: '파일 필수' });

    const ext      = file.originalname.split('.').pop();
    const fileName = `${manualId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('manual-media')
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from('manual-media')
      .getPublicUrl(fileName);

    const { data, error } = await supabase
      .from('manual_media')
      .insert({
        manual_id: manualId,
        type:      'image',
        url:       publicUrl,
        caption:   caption || ''
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);

  } catch (err) {
    console.error('[media upload error]', err.message);
    res.status(500).json({ error: '업로드 실패' });
  }
});

// 미디어 삭제
router.delete('/:mediaId', auth, async (req, res) => {
  const { error } = await supabase
    .from('manual_media')
    .delete()
    .eq('id', req.params.mediaId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
// 노드 이미지 업로드
router.post('/node/:manualId', auth, upload.single('file'), async (req, res) => {
  const { manualId } = req.params;
  const { caption, nodeLabel, storeId } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: '파일 필수' });

  try {
    const ext = file.originalname.split('.').pop();
    const fileName = `nodes/${manualId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('manual-media')
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from('manual-media')
      .getPublicUrl(fileName);

    const { data, error } = await supabase
      .from('manual_node_media')
      .insert({
        manual_id:  manualId,
        store_id:   storeId,
        node_label: nodeLabel,
        url:        publicUrl,
        caption:    caption || ''
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);

  } catch (err) {
    console.error('[node media error]', err.message);
    res.status(500).json({ error: '업로드 실패' });
  }
});

// 노드 이미지 삭제
router.delete('/node/:mediaId', auth, async (req, res) => {
  const { error } = await supabase
    .from('manual_node_media')
    .delete()
    .eq('id', req.params.mediaId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;

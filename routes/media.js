const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const multer  = require('multer');
const { supabase } = require('../lib/supabase');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                     'video/mp4', 'video/quicktime', 'video/webm'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('이미지 또는 영상만 가능해요'));
  }
});

// 미디어 업로드
router.post('/:manualId', auth, upload.single('file'), async (req, res) => {
  const { manualId } = req.params;
  const { caption } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: '파일 필수' });

  try {
    const isVideo = file.mimetype.startsWith('video/');
    const ext     = file.originalname.split('.').pop();
    const fileName = `${manualId}/${Date.now()}.${ext}`;

    // Supabase Storage 업로드
    const { error: uploadError } = await supabase.storage
      .from('manual-media')
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (uploadError) throw uploadError;

    // Public URL 가져오기
    const { data: { publicUrl } } = supabase.storage
      .from('manual-media')
      .getPublicUrl(fileName);

    // DB 저장
    const { data, error } = await supabase
      .from('manual_media')
      .insert({
        manual_id: manualId,
        type:      isVideo ? 'video' : 'image',
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
// 이미지 업로드
router.post('/:manualId', auth, upload.single('file'), async (req, res) => {
  const { manualId } = req.params;
  const { caption, type, url } = req.body;

  try {
    // 영상 URL인 경우 파일 없이 바로 저장
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
module.exports = router;

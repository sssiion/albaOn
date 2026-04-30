const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');

// 1. 카카오 로그인 페이지로 리다이렉트
router.get('/kakao', (req, res) => {
  const kakaoAuthUrl =
    `https://kauth.kakao.com/oauth/authorize` +
    `?client_id=${process.env.KAKAO_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.KAKAO_REDIRECT_URI)}` +
    `&response_type=code`;
  res.redirect(kakaoAuthUrl);
});

// 2. 카카오 콜백 처리
router.get('/kakao/callback', async (req, res) => {
  const { code } = req.query;

  console.log('=== 카카오 콜백 시작 ===');

  try {
    // 1. 토큰 발급
    const tokenRes = await axios.post(
      'https://kauth.kakao.com/oauth/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.KAKAO_CLIENT_ID,
        redirect_uri:  process.env.KAKAO_REDIRECT_URI,
        code,
        client_secret: process.env.KAKAO_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log('✅ 토큰 발급 성공');

    // 2. 유저 정보 조회
    const userRes = await axios.get('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    console.log('✅ 유저 정보 조회 성공');

    const kakaoUser = userRes.data;
    const email = kakaoUser.kakao_account?.email || null;
    const name  = kakaoUser.properties?.nickname || '사용자';
    console.log('name:', name, 'email:', email);

    // 3. DB upsert
    console.log('DB upsert 시도...');
    const { data: user, error } = await supabase
      .from('users')
      .upsert(
        {
          provider:    'kakao',
          provider_id: String(kakaoUser.id),
          email,
          name
        },
        { onConflict: 'provider,provider_id' }
      )
      .select()
      .single();

    if (error) {
      console.error('❌ DB 에러:', error);
      throw error;
    }
    console.log('✅ DB 저장 성공:', user.id);

    // 4. JWT 발급
    const token = jwt.sign(
      { userId: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    console.log('✅ JWT 발급 성공');

    // 5. 리다이렉트
    const redirectUrl = `${process.env.CLIENT_URL}/auth/callback?token=${token}`;
    console.log('✅ 리다이렉트:', redirectUrl);
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('❌ 에러:', err.message);
    console.error('❌ 상세:', err.response?.data || err);
    res.redirect(`${process.env.CLIENT_URL}/auth/error`);
  }
});
// 3. 내 정보 조회 (토큰 검증용)
router.get('/me', require('../middleware/auth'), async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, name, email, role, plan')
    .eq('id', req.user.userId)
    .single();

  res.json(user);
});
// 회원가입
router.post('/register', async (req, res) => {
  const { name, pin } = req.body;

  if (!name || !pin || pin.length !== 4) {
    return res.status(400).json({ error: '이름과 PIN 4자리 필수' });
  }

  try {
    // 이름 중복 확인
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('name', name.trim())
      .eq('provider', 'pin')
      .single();

    if (existing) {
      return res.status(400).json({ error: '이미 사용 중인 이름이에요' });
    }

    // 계정 생성
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        provider:    'pin',
        provider_id: `${name.trim()}_${pin}`,
        name:        name.trim(),
        role:        'owner'
      })
      .select()
      .single();

    if (error) throw error;

    // JWT 발급
    const token = jwt.sign(
      { userId: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: user.id, name: user.name } });

  } catch (err) {
    console.error('[register error]', err.message);
    res.status(500).json({ error: '회원가입 실패' });
  }
});

// 로그인
router.post('/login', async (req, res) => {
  const { name, pin } = req.body;

  if (!name || !pin) {
    return res.status(400).json({ error: '이름과 PIN 필수' });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('name', name.trim())
      .eq('provider', 'pin')
      .eq('provider_id', `${name.trim()}_${pin}`)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: '이름 또는 PIN이 틀렸어요' });
    }

    const token = jwt.sign(
      { userId: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: user.id, name: user.name } });

  } catch (err) {
    console.error('[login error]', err.message);
    res.status(500).json({ error: '로그인 실패' });
  }
});
module.exports = router;

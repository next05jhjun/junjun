// カラーレシピ：AIの中継所（Cloudflare Workers に貼り付けて使う）
//
// ・AIの鍵（ANTHROPIC_API_KEY）は Cloudflare の「シークレット」に入れる。このファイルやアプリには書かない
// ・サロンストックにログインしていて、許可したお店（ALLOWED_SALONS）のメンバーの人だけ使える
// ・写真はAIに渡すだけで、どこにも保存しない
//
// Cloudflare の「設定 → 変数とシークレット」に入れるもの
//   ANTHROPIC_API_KEY  … シークレット（Claude の鍵）
//   ALLOWED_SALONS     … 使ってよいお店のID（カンマ区切り）。カラーレシピの「設定」に出るID
//   ALLOWED_ORIGINS    … 省略可。既定は https://next05jhjun.github.io
//   MODEL              … 省略可。既定は claude-haiku-5-5

const PROJECT_ID = 'salon-stock-fbd9b';

const SYSTEM = `あなたは日本の美容室で使うヘアカラーのレシピを考えるアシスタントです。相手はプロの美容師です。
1枚目の写真は「なりたい色」（スクショ）、2枚目は「今の髪」です。

守ること
- 薬剤は、渡された「この店の薬剤リスト」にあるものだけを使う。dyeId にはリストの id をそのまま入れる。リストに無い薬剤は書かない
- 「ノンジアミン」の薬剤と、ふつうの（ジアミンの）薬剤は混ぜない。指定された系統の中だけで組む
- オキシ（2剤）の％は、日本でふつうに使う 1.5％・3％・6％ から選ぶ。2剤がリストにあればその名前を note に書く
- 1剤と2剤の割合（oxyRatio）は、そのメーカーのふつうの割合（例 1:1、1:1.5、1:2）。わからなければ「メーカーの説明書どおり」と書く
- 量（grams）は1剤の量。肩くらいの長さで根元30〜40g、毛先は長さに合わせて足す
- 写真の色は光やフィルターで明るく・薄く見えやすい。この店では、前に試したとき「少し薄めに出た」ので、迷ったら少し濃いめ・暗めを選ぶ
- 根元（新しく伸びた部分）と毛先（前のカラーが残っている部分）は分けて考える。同じでよければ endsSameAsRoot を true にして、ends にも同じ内容を入れる
- 明るさを2レベルより大きく上げる、ブリーチが要る、黒染めの上から明るくする、など1回では難しいときは plan と warnings にはっきり書く
- 白髪の量が多いときは白髪の染まり（ブラウン系を混ぜるなど）を考える
- 説明はやさしい日本語で短く。専門用語を使うときは一言で説明する
- 最終判断は美容師がする前提で、気をつける点を warnings に書く`;

const MIX = { type: 'object', additionalProperties: false, required: ['dyeId', 'name', 'grams'],
  properties: { dyeId: { type: 'string' }, name: { type: 'string' }, grams: { type: 'number' } } };
const STEP = { type: 'object', additionalProperties: false, required: ['mix', 'oxyPercent', 'oxyRatio', 'minutes', 'note'],
  properties: { mix: { type: 'array', items: MIX }, oxyPercent: { type: 'number' }, oxyRatio: { type: 'string' }, minutes: { type: 'number' }, note: { type: 'string' } } };
const SCHEMA = { type: 'object', additionalProperties: false,
  required: ['current', 'target', 'plan', 'line', 'root', 'ends', 'endsSameAsRoot', 'warnings', 'confidence'],
  properties: {
    current: { type: 'string', description: '今の髪の明るさ（レベル）と色味' },
    target: { type: 'string', description: 'なりたい色の明るさ（レベル）と色味' },
    plan: { type: 'string', description: '全体の考え方（1〜3文）' },
    line: { type: 'string', enum: ['normal', 'nd', 'mairy'] },
    root: STEP, ends: STEP, endsSameAsRoot: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'mid', 'low'] },
  } };

const LINE_LABEL = { any: 'おまかせ（ふつうかノンジアミンのどちらか一方）', normal: 'ふつう（ジアミン）', nd: 'ノンジアミン', mairy: 'メイリー' };
const KIND_LABEL = { normal: 'ふつう', nd: 'ノンジアミン', mairy: 'メイリー', oxy: '2剤（オキシ）', bleach: 'ブリーチ', other: 'その他' };
const b64pad = (x) => { x = x.replace(/-/g, '+').replace(/_/g, '/'); return x + '='.repeat((4 - x.length % 4) % 4); };
const s = (v, n) => String(v == null ? '' : v).slice(0, n);

export default {
  async fetch(req, env) {
    const origins = (env.ALLOWED_ORIGINS || 'https://next05jhjun.github.io').split(',').map(x => x.trim());
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': origins.includes(origin) ? origin : origins[0], 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return out({ error: 'POST で送ってください' }, 405);
    if (!origins.includes(origin)) return out({ error: 'このサイトからは使えません' }, 403);
    if (!env.ANTHROPIC_API_KEY) return out({ error: '中継所にAIの鍵が入っていません' }, 500);

    const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    let b; try { b = await req.json(); } catch (e) { return out({ error: '送られた内容が読めません' }, 400); }
    const salon = s(b.salon, 80);
    if (!idToken || !/^[A-Za-z0-9_-]{1,80}$/.test(salon)) return out({ error: 'ログインとお店の情報がありません' }, 401);
    const allowed = (env.ALLOWED_SALONS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!allowed.includes(salon)) return out({ error: 'このお店はまだ使えるように設定されていません（お店のID：' + salon + '）' }, 403);

    // だれか → そのお店のメンバーか。ログインの鍵が本物かどうかは Firestore が確かめる（偽物なら読めない）
    let uid = '';
    try { const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64pad(idToken.split('.')[1])), c => c.charCodeAt(0)))); if (p.aud === PROJECT_ID) uid = p.user_id || p.sub || ''; } catch (e) {}
    if (!/^[A-Za-z0-9]{1,128}$/.test(uid)) return out({ error: 'ログインの情報が読めません。もう一度ログインしてください' }, 401);
    const mem = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/salons/${salon}/members/${uid}`, {
      headers: { Authorization: 'Bearer ' + idToken } });
    if (!mem.ok) return out({ error: 'このお店のメンバーではありません' }, 403);

    // 中身のチェック
    const imgs = Array.isArray(b.images) ? b.images.slice(0, 2) : [];
    if (imgs.length !== 2 || imgs.some(x => !x || !/^image\/(jpeg|png|webp)$/.test(x.media_type) || typeof x.data !== 'string' || x.data.length > 4_000_000))
      return out({ error: '写真は2枚（なりたい色・今の髪）が必要です' }, 400);
    const dyes = (Array.isArray(b.dyes) ? b.dyes : []).slice(0, 300).map(d => ({ id: s(d.id, 60), name: s(d.name, 80), kind: s(d.kind, 10) }));
    if (!dyes.length) return out({ error: '薬剤が1つもありません' }, 400);
    const line = LINE_LABEL[b.line] ? b.line : 'any';
    const bias = b.bias && typeof b.bias === 'object' ? b.bias : {};
    const n = (v) => Math.max(0, Math.min(999, Number(v) || 0));
    const fbText = (n(bias.thin) + n(bias.ok) + n(bias.thick))
      ? `この店で最近このレシピを使った結果：薄かった ${n(bias.thin)}回・ちょうど ${n(bias.ok)}回・濃かった ${n(bias.thick)}回。${n(bias.thin) > n(bias.thick) ? 'その分、少し濃いめ・暗めに補正する。' : n(bias.thick) > n(bias.thin) ? 'その分、少し薄め・明るめに補正する。' : ''}`
      : 'この店での使用結果はまだない。';
    const details = [
      '【この店の薬剤リスト】',
      ...dyes.map(d => `- id:${d.id} / ${d.name} / ${KIND_LABEL[d.kind] || 'ふつう'}`),
      '',
      '【使う系統】' + LINE_LABEL[line],
      '【白髪】' + ({ none: 'ほぼ無し', some: '少しある', many: '多い' }[b.gray] || 'わからない'),
      '【ブリーチ・黒染めの履歴】' + s(b.history, 100),
      '【美容師からの一言】' + (s(b.note, 300) || 'なし'),
      '【店の補正】' + fbText,
    ].join('\n');

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify({
        model: env.MODEL || 'claude-haiku-5-5',
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: [
          { type: 'text', text: '1枚目：なりたい色' },
          { type: 'image', source: { type: 'base64', media_type: imgs[0].media_type, data: imgs[0].data } },
          { type: 'text', text: '2枚目：今の髪' },
          { type: 'image', source: { type: 'base64', media_type: imgs[1].media_type, data: imgs[1].data } },
          { type: 'text', text: details },
        ] }],
      }),
    });
    const aj = await ar.json().catch(() => ({}));
    if (!ar.ok) {
      const m = (aj.error && aj.error.message) || ('HTTP ' + ar.status);
      return out({ error: ar.status === 429 ? 'AIが混んでいます。少し待ってもう一度押してください' : /credit|billing/i.test(m) ? 'AIの残高が足りません（Claude の管理画面で確認）' : 'AIでエラー：' + m }, 502);
    }
    if (aj.stop_reason === 'refusal') return out({ error: 'AIがこの写真には答えられませんでした。別の写真で試してください' }, 422);
    if (aj.stop_reason === 'max_tokens') return out({ error: 'AIの答えが長すぎて途中で切れました。もう一度押してください' }, 502);
    const text = (aj.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    let recipe; try { recipe = JSON.parse(text); } catch (e) { return out({ error: 'AIの答えが読めませんでした。もう一度押してください' }, 502); }
    return out({ recipe, model: aj.model, usage: aj.usage });
  },
};

// 화면 언어(마스터 #821·#823). 사전은 서버가 /i18n-dict.js 로 낸 window.BS_I18N(저장소 i18n/<언어>.json 전부).
// 고르는 순서: 이 기기에서 고른 값(localStorage bs.lang) → 브라우저 언어 → 기본(ko). 고르면 서버 언어도 같이 바꾼다(app.js — 에이전트 규약이 따른다).
// 쓰는 법: t('키', {이름: 값}) · HTML 은 data-i18n="키"(글자) · data-i18n-attr="title:키;placeholder:키;aria-label:키"(속성).
// 빠진 키는 ko 로, ko 에도 없으면 키 그대로 보인다(빠진 것이 눈에 띄게).
'use strict';

const I18N = (() => {
  const B = window.BS_I18N || { default: 'ko', langs: [{ code: 'ko', name: '한국어' }], dicts: { ko: {} } };
  const known = (l) => (l && B.dicts[l] ? l : l && B.dicts[String(l).split(/[-_]/)[0].toLowerCase()] ? String(l).split(/[-_]/)[0].toLowerCase() : null);
  function pick() {
    let saved = null;
    try {
      saved = localStorage.getItem('bs.lang');
    } catch {}
    if (known(saved)) return known(saved);
    for (const l of navigator.languages || [navigator.language]) if (known(l)) return known(l);
    return B.default;
  }
  const lang = pick();
  const dict = B.dicts[lang] || {};
  const base = B.dicts[B.default] || {};
  function t(key, vars) {
    let s = dict[key] ?? base[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (all, k) => (vars[k] === undefined || vars[k] === null ? all : String(vars[k])));
    return s;
  }
  function apply(root) {
    const r = root || document;
    for (const el of r.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
    for (const el of r.querySelectorAll('[data-i18n-attr]'))
      for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
        const [attr, key] = pair.split(':').map((x) => x.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
  }
  return {
    lang,
    langs: B.langs,
    /** Intl 용 지역 표기(ko → ko-KR) — 사전의 _meta.locale */
    locale: t('_meta.locale') === '_meta.locale' ? lang : t('_meta.locale'),
    t,
    apply,
    /** 이 기기의 언어를 바꾼다(다시 읽어야 화면 전체가 바뀐다) */
    save(l) {
      try {
        localStorage.setItem('bs.lang', l);
      } catch {}
    },
  };
})();
const t = I18N.t;
document.documentElement.lang = I18N.lang;
I18N.apply();

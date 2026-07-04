// 輕量雙語（繁中 / English）i18n——供各靜態頁共用。
// 用法：元素加 data-i18n="key"（內文）或 data-i18n-title="key"（title 屬性）；
//   zh 直接取 DOM 原文為預設，只需在字典提供 en。
// JSI18N.register({key:{en:'...'}})→JSI18N.apply()；JSI18N.set('en')；JSI18N.lang()。
(function (w) {
  const KEY = 'js-lang';
  const dict = {};                 // key → { en }
  const zhCache = {};              // key → 原始繁中文字（首次 apply 時擷取）
  let lang = localStorage.getItem(KEY) || 'zh';

  function textOf(el) {
    return el.getAttribute('data-i18n-title') ? '__title__' : null;
  }

  function apply() {
    // 內容用 innerHTML（字典皆為開發者靜態字串，允許 <b> 等排版標籤；非使用者輸入）
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (!(k in zhCache)) zhCache[k] = el.innerHTML;
      const en = dict[k] && dict[k].en;
      el.innerHTML = (lang === 'en' && en != null) ? en : zhCache[k];
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const k = el.getAttribute('data-i18n-title');
      const ck = '@title:' + k;
      if (!(ck in zhCache)) zhCache[ck] = el.getAttribute('title') || '';
      const en = dict[k] && dict[k].en;
      el.setAttribute('title', (lang === 'en' && en != null) ? en : zhCache[ck]);
    });
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-Hant');
    w.dispatchEvent(new CustomEvent('js-lang-change', { detail: { lang } }));
  }

  w.JSI18N = {
    register(d) { Object.assign(dict, d); return this; },
    apply,
    set(l) { lang = (l === 'en') ? 'en' : 'zh'; localStorage.setItem(KEY, lang); apply(); },
    lang() { return lang; },
    t(k, zh) {  // 程式內動態字串：t('key','繁中預設')
      if (lang === 'en' && dict[k] && dict[k].en != null) return dict[k].en;
      return zh != null ? zh : (zhCache[k] ?? k);
    },
  };
})(window);

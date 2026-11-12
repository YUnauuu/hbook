// Add the novel side's strings to every locale file.
//
// The keys ARE the English source strings, so a missing entry falls back to English. But the
// locale-coverage test wants every key present and non-empty in all eight files, and each file
// counts its own strings in `_meta.strings` -- a count that goes stale the moment a key is added.
//
//   node scripts/add-novel-locale-keys.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = path.join(ROOT, 'public', 'locales');

const STRINGS = {
  'Novels': {
    ar: 'روايات',
    de: 'Romane',
    es: 'Novelas',
    fr: 'Romans',
    ja: '小説',
    'pt-BR': 'Romances',
    ru: 'Романы',
    zh: '小说',
  },
  'Search novels': {
    ar: 'ابحث في الروايات',
    de: 'Romane durchsuchen',
    es: 'Buscar novelas',
    fr: 'Rechercher des romans',
    ja: '小説を検索',
    'pt-BR': 'Buscar romances',
    ru: 'Поиск романов',
    zh: '搜索小说',
  },
  'Search failed: {message}': {
    ar: 'فشل البحث: {message}',
    de: 'Suche fehlgeschlagen: {message}',
    es: 'La búsqueda falló: {message}',
    fr: 'Échec de la recherche : {message}',
    ja: '検索に失敗しました: {message}',
    'pt-BR': 'A busca falhou: {message}',
    ru: 'Поиск не удался: {message}',
    zh: '搜索失败：{message}',
  },
  'No results — try another source.': {
    ar: 'لا نتائج — جرّب مصدرًا آخر.',
    de: 'Keine Ergebnisse — versuche eine andere Quelle.',
    es: 'Sin resultados: prueba con otra fuente.',
    fr: 'Aucun résultat — essayez une autre source.',
    ja: '結果がありません — 別のソースをお試しください。',
    'pt-BR': 'Nenhum resultado — tente outra fonte.',
    ru: 'Ничего не найдено — попробуйте другой источник.',
    zh: '没有找到结果——换个来源试试。',
  },
  '(some sources timed out)': {
    ar: '(انتهت مهلة بعض المصادر)',
    de: '(bei einigen Quellen lief die Zeit ab)',
    es: '(algunas fuentes agotaron el tiempo)',
    fr: '(certaines sources ont expiré)',
    ja: '（一部のソースがタイムアウトしました）',
    'pt-BR': '(algumas fontes expiraram)',
    ru: '(некоторые источники не ответили вовремя)',
    zh: '（部分来源超时）',
  },
  '{n} sources failed': {
    ar: 'فشل {n} من المصادر',
    de: '{n} Quellen fehlgeschlagen',
    es: '{n} fuentes fallaron',
    fr: '{n} sources en échec',
    ja: '{n} 件のソースが失敗しました',
    'pt-BR': '{n} fontes falharam',
    ru: 'источников с ошибкой: {n}',
    zh: '{n} 个来源出错',
  },
  '1 source failed': {
    ar: 'فشل مصدر واحد',
    de: '1 Quelle fehlgeschlagen',
    es: '1 fuente falló',
    fr: '1 source en échec',
    ja: '1 件のソースが失敗しました',
    'pt-BR': '1 fonte falhou',
    ru: '1 источник с ошибкой',
    zh: '1 个来源出错',
  },
  'Table of contents ({n})': {
    ar: 'الفهرس ({n})',
    de: 'Inhaltsverzeichnis ({n})',
    es: 'Tabla de contenidos ({n})',
    fr: 'Table des matières ({n})',
    ja: '目次（{n}）',
    'pt-BR': 'Sumário ({n})',
    ru: 'Содержание ({n})',
    zh: '目录（{n}）',
  },
  'Latest: {title}': {
    ar: 'الأحدث: {title}',
    de: 'Neueste: {title}',
    es: 'Más reciente: {title}',
    fr: 'Le plus récent : {title}',
    ja: '最新：{title}',
    'pt-BR': 'Mais recente: {title}',
    ru: 'Последнее: {title}',
    zh: '最新：{title}',
  },
  'This source gave no table of contents.': {
    ar: 'لم يعطِ هذا المصدر أي فهرس.',
    de: 'Diese Quelle hat kein Inhaltsverzeichnis geliefert.',
    es: 'Esta fuente no dio tabla de contenidos.',
    fr: "Cette source n'a pas donné de table des matières.",
    ja: 'このソースは目次を返しませんでした。',
    'pt-BR': 'Esta fonte não deu sumário.',
    ru: 'Этот источник не вернул оглавление.',
    zh: '这个来源没有给出目录。',
  },
  'Could not open this book: {message}': {
    ar: 'تعذّر فتح هذا الكتاب: {message}',
    de: 'Dieses Buch konnte nicht geöffnet werden: {message}',
    es: 'No se pudo abrir este libro: {message}',
    fr: "Impossible d'ouvrir ce livre : {message}",
    ja: 'この本を開けませんでした: {message}',
    'pt-BR': 'Não foi possível abrir este livro: {message}',
    ru: 'Не удалось открыть эту книгу: {message}',
    zh: '无法打开这本书：{message}',
  },
  'Could not load the chapter: {message}': {
    ar: 'تعذّر تحميل الفصل: {message}',
    de: 'Das Kapitel konnte nicht geladen werden: {message}',
    es: 'No se pudo cargar el capítulo: {message}',
    fr: 'Impossible de charger le chapitre : {message}',
    ja: 'この章を読み込めませんでした: {message}',
    'pt-BR': 'Não foi possível carregar o capítulo: {message}',
    ru: 'Не удалось загрузить главу: {message}',
    zh: '无法加载章节：{message}',
  },
  'This chapter has no content.': {
    ar: 'هذا الفصل فارغ.',
    de: 'Dieses Kapitel hat keinen Inhalt.',
    es: 'Este capítulo no tiene contenido.',
    fr: 'Ce chapitre est vide.',
    ja: 'この章には内容がありません。',
    'pt-BR': 'Este capítulo não tem conteúdo.',
    ru: 'В этой главе нет содержимого.',
    zh: '这一章没有内容。',
  },
  'not found': {
    ar: 'غير موجود',
    de: 'nicht gefunden',
    es: 'no encontrado',
    fr: 'introuvable',
    ja: '見つかりません',
    'pt-BR': 'não encontrado',
    ru: 'не найдено',
    zh: '未找到',
  },
};

let touched = 0;
for (const file of fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json'))) {
  const lang = path.basename(file, '.json');
  const full = path.join(LOCALES, file);
  const dict = JSON.parse(fs.readFileSync(full, 'utf8'));
  let added = 0;
  for (const [key, byLang] of Object.entries(STRINGS)) {
    const value = byLang[lang];
    if (!value) throw new Error(`no ${lang} translation for "${key}"`);
    if (dict[key] === undefined) added++;
    dict[key] = value;
  }
  if (dict._meta) dict._meta.strings = Object.keys(dict).length - 1;
  fs.writeFileSync(full, JSON.stringify(dict, null, 2) + '\n');
  touched++;
  console.log(`${file}: +${added} keys, ${Object.keys(dict).length - 1} strings`);
}
console.log(`\n${touched} locale file(s) updated.`);
